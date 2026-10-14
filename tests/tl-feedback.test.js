/* SUBMIT FEEDBACK: the third way out of TL Approved.
 *
 * WHAT THE STUDIO ASKED FOR. TL Approved had two exits and both went forwards —
 * on to the Creative Director, or past them to the client. A lead who approved
 * the work and then spotted something had nothing to click: tl_request_changes
 * is defined from pending_tl_review and the approval had already used it up. So
 * the work went on with the fault in it, or somebody reassigned the asset to
 * fake a round.
 *
 * WHAT WAS ALREADY THERE, and this is most of why the change is small:
 *
 *   TL Feedbacks (tl_changes_requested) EXISTS, fed today by a decline at TL
 *      Review. It is in ASSIGNEE_STATUSES, REWORK_STATUSES, WORKING_STATUSES
 *      (so the clock runs on the rework), HAND_OVER_STATUSES, the page's hold
 *      list, its start list and its Assets List groups.
 *   THE FEEDBACK MECHANISM EXISTS: a row in `feedback` — stage 'tl', decision
 *      'changes_requested', given_by, text — written by POST /:id/review, read
 *      by the artist's "Feedback to address" box and the Review feedback list.
 *
 * So this file is careful about three things rather than about a new stage:
 *
 *   THE LOOP CANNOT STRAND WORK. Walked end to end against a live server: the
 *      lead submits, the artist sees it, starts the clock, submits the rework,
 *      and it comes back to TL Review and then TL Approved — where the two
 *      existing buttons still work.
 *   THE RULE IS STATED ONCE. src/tl-feedback.js decides, the route asks it, the
 *      board asks it per asset, and the page draws the answer. The page is read
 *      here to prove it holds no second copy — which is the defect four reports
 *      of the Hold button were about.
 *   NOTHING IS COUNTED TWICE. A round in this application is a submission, so
 *      asking for changes creates none and the rework's submit creates exactly
 *      one, whichever of the two paths asked for the changes.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const workflow = require('../src/asset-workflow');
const tlFeedback = require('../src/tl-feedback');
const { REWORK_STATUSES } = require('../src/permissions');
const { config, resetSchema, startServer, stopServer, api, sql, openStudio, SKIP_REASON } =
  require('./helpers');

const cfg = config('tlfeedback');
const PASSWORD = 'TlFeedback-1!';
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const SRC = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');

// ===========================================================================
// 1. THE TRANSITION, with no server.
// ===========================================================================

test('the transition goes from TL Approved to the stage that already exists', () => {
  const t = workflow.transitionFor('tl_submit_feedback');
  assert.ok(t, 'the action is in the transition table');
  assert.deepStrictEqual(t.from, ['tl_approved'], 'from TL Approved, and nowhere else');
  assert.strictEqual(t.to, 'tl_changes_requested', 'to TL Feedbacks');
  assert.strictEqual(t.who, 'tlFeedbackSubmitter');
  assert.strictEqual(t.requiresNote, true, 'the feedback is required by the table too');
  assert.strictEqual(t.routeTo, 'assignee',
    'routed to the artist, the same way a decline at TL Review is');

  /* THE DESTINATION IS A REWORK STAGE THE WHOLE APPLICATION ALREADY KNOWS, and
     these four lists are why nothing else needed changing. Asserted rather than
     assumed, because the change would be worthless if the artist landed in a
     stage they could not work in. */
  assert.ok(REWORK_STATUSES.includes(t.to), 'TL Feedbacks is a rework stage');
  assert.ok(workflow.WORKING_STATUSES.includes(t.to), 'the clock can run on the rework');
  assert.ok(workflow.ASSIGNEE_STATUSES.includes(t.to), 'and it belongs to the assignee');
  assert.ok(workflow.transitionFor('submit').from.includes(t.to),
    'and submit takes it back out again — the loop closes');
});

test('the submitted feedback goes back to the same gate, and the old buttons still apply', () => {
  /* WHERE IT RE-ENTERS, read off the table rather than off the screen. The
     artist's submit from TL Feedbacks lands at TL Review; approving there lands
     in TL Approved; and TL Approved still has its two forward exits. So the
     second pass is the first pass, which is the property that makes this safe to
     offer more than once. */
  const back = workflow.TRANSITIONS.find((x) => x.action === 'submit'
    && x.from.includes('tl_changes_requested'));
  assert.strictEqual(back.to, 'pending_tl_review', 'the rework is submitted to TL Review');

  const approve = workflow.transitionFor('tl_approve');
  assert.ok(approve.from.includes('pending_tl_review'));
  assert.strictEqual(approve.to, 'tl_approved', 'and approving puts it back in TL Approved');

  for (const action of ['tl_to_cd', 'tl_send_to_client', 'tl_submit_feedback']) {
    assert.ok(workflow.transitionFor(action).from.includes('tl_approved'),
      `${action} is still offered from TL Approved on the next pass`);
  }
});

test('the history sentence names the person and quotes the feedback', () => {
  const ctx = { user: { id: 'u1', name: 'Priya Nair' },
    asset: { status: 'tl_approved', assignee_id: 'a1' },
    isTeamLead: true, canSubmitTlFeedback: true };
  const said = 'The rim light on the hero reads flat — raise it and re-render the turntable.';
  const v = workflow.evaluate('tl_submit_feedback', ctx, { note: said });
  assert.strictEqual(v.ok, true, JSON.stringify(v));
  assert.strictEqual(v.describe, `Feedback submitted by Priya Nair: ${said}`);
  assert.strictEqual(v.to, 'tl_changes_requested');
  assert.strictEqual(v.routedTo, 'a1', 'and it is routed to the artist');

  /* Long feedback is summarised in the sentence and kept whole on the event row
     — the note is the record, this is the line above it. */
  const long = workflow.evaluate('tl_submit_feedback', ctx, { note: 'x'.repeat(400) });
  assert.ok(long.describe.length < 200, 'the quote is trimmed');
  assert.ok(long.describe.endsWith('…'), 'and says it was trimmed');

  /* Degrades rather than breaks: a deactivated reviewer's name can be missing
     long after the row was written, and a history line still has to read. */
  const nameless = workflow.evaluate('tl_submit_feedback',
    { ...ctx, user: { id: 'u1' } }, { note: said });
  assert.strictEqual(nameless.describe, `Feedback submitted: ${said}`);
});

test('every other status is refused, and the refusal names TL Approved', () => {
  const ctx = { user: { id: 'u1', name: 'P' }, isTeamLead: true, canSubmitTlFeedback: true };
  for (const status of workflow.STATE_IDS) {
    const v = workflow.evaluate('tl_submit_feedback',
      { ...ctx, asset: { status, assignee_id: 'a1' } }, { note: 'Raise the rim light please' });
    if (status === 'tl_approved') {
      assert.strictEqual(v.ok, true, 'TL Approved is allowed');
      continue;
    }
    assert.strictEqual(v.ok, false, `${status} must be refused`);
    assert.strictEqual(v.status, 409, `${status} is a conflict, not a permission failure`);
    assert.match(v.error, /TL Approved/,
      `${status}: the refusal has to say where feedback is submitted from`);
  }
});

test('the two gates agree about every status and every permission combination', () => {
  /* THE DISAGREEMENT THIS FILE EXISTS TO PREVENT. Two things decide this
   * action: src/tl-feedback.js, which the button and the route both ask, and the
   * transition table, which every status change in the application passes
   * through. If one allowed what the other refused, the button would be drawn
   * and then answer 403 — or worse, the reverse.
   *
   * Driven as a matrix rather than sampled, because the pair agreeing on the
   * happy path is exactly what the earlier Hold reports kept establishing. */
  for (const status of workflow.STATE_IDS) {
    for (const key of [true, false]) {
      for (const gate of [true, false]) {
        const asset = { status, assignee_id: 'a1', code: 'FX-001' };
        const module = tlFeedback.decide({ asset, holdsPermission: key, onGate: gate });
        const table = workflow.evaluate('tl_submit_feedback',
          { user: { id: 'u1', name: 'P' }, asset, isTeamLead: gate, canSubmitTlFeedback: key },
          { note: 'Raise the rim light please' });
        assert.strictEqual(module.ok, table.ok,
          `${status} key=${key} gate=${gate}: the module says ${module.ok} and the table ${table.ok}`);
      }
    }
  }
});

// ===========================================================================
// 2. THE DECISION MODULE: who, and what they typed.
// ===========================================================================

test('the decision, case by case, with the reason it gives', () => {
  const asset = { status: 'tl_approved', code: 'FX-001', assignee_id: 'a1' };
  const base = { asset, holdsPermission: true, onGate: true };

  assert.strictEqual(tlFeedback.decide(base).ok, true);

  const cases = [
    [{ ...base, holdsPermission: false }, 'NO_PERMISSION', 'permission', /TL Submit Feedback/],
    [{ ...base, onGate: false }, 'NOT_ON_GATE', 'authority', /review team/],
    [{ ...base, asset: { ...asset, status: 'delivered' } }, 'WRONG_STATUS', 'status',
      /no longer in TL Approved/],
    [{ ...base, outsourcedTo: { freelancerName: 'Ravi K.' } }, 'OUTSOURCED', 'outsourced',
      /Ravi K\./],
    [{ ...base, asset: { ...asset, assignee_id: null } }, 'UNASSIGNED', 'assignee',
      /nobody assigned/],
    [{ unavailable: true }, 'UNKNOWN', 'unavailable', /could not be checked/],
  ];
  for (const [facts, code, gate, says] of cases) {
    const d = tlFeedback.decide(facts);
    assert.strictEqual(d.ok, false, code);
    assert.strictEqual(d.code, tlFeedback.CODES[code], `${code}: got ${d.code}`);
    assert.strictEqual(d.gate, gate, `${code} is a ${gate} question`);
    assert.match(d.message, says, `${code}: ${d.message}`);
  }

  /* THE ORDER OF TWO OF THEM IS THE RULE, not an accident — the lesson taken
     whole from src/asset-hold.js. An outsourced task has no internal assignee,
     so the unassigned check would catch it first and answer "nobody is
     assigned", naming a person who does not exist and hiding the real reason. */
  const both = tlFeedback.decide({ ...base, asset: { ...asset, assignee_id: null },
    outsourcedTo: { freelancerName: 'Ravi K.' } });
  assert.strictEqual(both.code, tlFeedback.CODES.OUTSOURCED,
    'out with a freelancer is answered before "nobody is assigned"');

  /* And UNKNOWN is answered before everything, because it is not a refusal
     about the person — it is us saying we could not find out. */
  const unknown = tlFeedback.decide({ unavailable: true, holdsPermission: false, onGate: false });
  assert.strictEqual(unknown.code, tlFeedback.CODES.UNKNOWN);
});

test('the feedback itself: required, long enough, and not absurd', () => {
  const { MIN_LENGTH, MAX_LENGTH } = tlFeedback;
  assert.ok(MIN_LENGTH > 1 && MIN_LENGTH < 40, 'the minimum is a judgement, not a wall');
  assert.ok(MAX_LENGTH >= 500, 'and the maximum leaves room for real notes');

  for (const empty of ['', null, undefined, '   ', '\n\t  \n']) {
    const v = tlFeedback.validate(empty);
    assert.strictEqual(v.ok, false, `${JSON.stringify(empty)} is not feedback`);
    assert.strictEqual(v.status, 400);
    assert.strictEqual(v.field, 'text');
  }
  /* WHITESPACE IS NOT LENGTH. Measured after trimming, which is also what is
     stored — so the thing validated and the thing kept are one string. */
  const padded = tlFeedback.validate(`   ${'a'.repeat(MIN_LENGTH)}   `);
  assert.strictEqual(padded.ok, true);
  assert.strictEqual(padded.text, 'a'.repeat(MIN_LENGTH), 'and it hands back the trimmed text');

  assert.strictEqual(tlFeedback.validate('a'.repeat(MIN_LENGTH - 1)).ok, false, 'one short');
  assert.strictEqual(tlFeedback.validate('a'.repeat(MIN_LENGTH)).ok, true, 'exactly enough');
  assert.strictEqual(tlFeedback.validate('a'.repeat(MAX_LENGTH)).ok, true, 'exactly the limit');
  const over = tlFeedback.validate('a'.repeat(MAX_LENGTH + 1));
  assert.strictEqual(over.ok, false, 'one over');
  assert.match(over.error, new RegExp(String(MAX_LENGTH)), 'and the message says the limit');
});

test('the stage it is offered from is read off the transition table, not retyped', () => {
  /* The arrangement WORKING_STATUSES has with src/asset-hold.js: the module that
     owns the status vocabulary states the list and everything else asks it. */
  assert.deepStrictEqual(tlFeedback.FROM_STATUSES,
    workflow.transitionFor('tl_submit_feedback').from);
  assert.strictEqual(tlFeedback.TO_STATUS, 'tl_changes_requested');
  const src = SRC('tl-feedback.js');
  assert.match(src, /workflow\.transitionFor\('tl_submit_feedback'\)\.from/,
    'FROM_STATUSES is derived');
  assert.ok(!/const FROM_STATUSES = \[/.test(src), 'and not a second hand-written list');
});

// ===========================================================================
// 3. THE SERVER'S LISTS AND THE PAGE'S, HELD EQUAL.
// ===========================================================================

test('the page holds no copy of the rule, only of the stage name', () => {
  /* WHAT THE PAGE IS ALLOWED TO KNOW: the stage, for the sentence under the
     button. Everything else — the permission, the project, the assignee, the
     freelancer — comes from feedback_state. This is the assertion that the
     fourth report of the Hold button asked for, written before the first
     report rather than after the fourth. */
  const list = PAGE.match(/const FEEDBACK_FROM_STATUSES = \[([^\]]*)\];/);
  assert.ok(list, 'public/index.html has no FEEDBACK_FROM_STATUSES');
  assert.deepStrictEqual(
    list[1].split(',').map((v) => v.trim().replace(/'/g, '')).filter(Boolean),
    tlFeedback.FROM_STATUSES,
    'the page and src/tl-feedback.js disagree about which stage offers the button');

  /* THE LIMITS TOO: the counter and the validator must mean the same thing by
     "too short", and the page's fallback carries numbers for the case where the
     server sent none. */
  const unknown = PAGE.match(/const UNKNOWN_FEEDBACK_STATE = \{([\s\S]*?)\n\};/);
  assert.ok(unknown, 'the page has no UNKNOWN_FEEDBACK_STATE');
  assert.match(unknown[1], new RegExp(`minLength:\\s*${tlFeedback.MIN_LENGTH}\\b`));
  assert.match(unknown[1], new RegExp(`maxLength:\\s*${tlFeedback.MAX_LENGTH}\\b`));
  assert.match(unknown[1], /canSubmit:\s*false/,
    'and an undecorated row offers nothing until the server says otherwise');

  /* NO LOCAL RECOMPUTATION. The two older buttons at this stage mirror their
     actor by hand — `mayActAtTlGate(a) && a.status==='tl_approved'` — and that
     is the shape this one must not copy. Its decision is one property read. */
  const at = PAGE.indexOf('const fbState = a.feedback_state');
  assert.ok(at !== -1, 'the page reads feedback_state');
  const decision = PAGE.slice(at, PAGE.indexOf('const feedbackWhy', at));
  assert.match(decision, /fbState\.canSubmit === true/);
  for (const leak of ['can(', 'mayActAtTlGate', 'assignee_id', 'outsourced_to']) {
    assert.ok(!decision.includes(leak),
      `the button must not decide on ${leak} — the server already did`);
  }

  /* AND THE MARKUP FOLLOWS THAT ONE ANSWER: the live button when the server says
     yes, a disabled one carrying the server's sentence for the refusals worth
     explaining, and nothing at all otherwise. */
  const markup = PAGE.slice(PAGE.indexOf('<!-- And back, which is the other thing a lead'),
    PAGE.indexOf('${canCdReview ?'));
  assert.match(markup, /\$\{canSubmitFeedback \? `<button[^`]*id="tlFeedbackBtn"/,
    'the live button is drawn only when the server allows it');
  assert.match(markup, /feedbackWhy \? `<button[^`]*id="tlFeedbackBtn"[^`]*disabled/,
    'and a disabled one when the refusal is worth showing');
  assert.match(markup, /escapeHTML\(feedbackWhy\)/, 'with the server\'s own sentence');
  assert.ok(!/Submit Feedback<\/button>`\s*:\s*''\s*\}[\s\S]{0,40}<button/.test(markup),
    'and nothing else in its place');
});

test('the artist\'s side of TL Feedbacks is the one that already existed', () => {
  /* Nothing here is new, and that is the claim: the stage the feedback lands in
     is the stage a decline at TL Review lands in, so every list that already
     named it still does. If one of these drifts, the rework becomes unworkable
     and the asset is stranded — which is the failure the brief asked to be
     guarded against. */
  const pageList = (name) => {
    const m = PAGE.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
    assert.ok(m, `public/index.html has no ${name}`);
    return m[1].split(',').map((v) => v.trim().replace(/'/g, '')).filter(Boolean);
  };
  assert.deepStrictEqual(pageList('REWORK_STATUSES').sort(), [...REWORK_STATUSES].sort());
  assert.deepStrictEqual(pageList('HOLD_STATUSES').sort(),
    [...workflow.WORKING_STATUSES].sort());
  assert.ok(pageList('REWORK_STATUSES').includes('tl_changes_requested'));
  assert.ok(pageList('HOLD_STATUSES').includes('tl_changes_requested'),
    'the clock can be held on the rework');

  /* The page's own start list, which is STARTABLE's copy. Read from the drawer
     rather than from a named const because that is where it lives. */
  const mayStart = PAGE.slice(PAGE.indexOf('const mayStart = (a.assignee_id===u.id'));
  const started = mayStart.slice(0, mayStart.indexOf('].includes(a.status)'));
  assert.ok(started.includes("'tl_changes_requested'"),
    'the artist can start the clock on work sent back to them');

  /* AND IT IS NOT GATED BEHIND A RELAY. CD Feedbacks and a game bug wait for a
     lead to pass them on; TL Feedbacks is routed straight to the artist, so it
     must NOT be in the awaiting-hand-over list on either side. */
  const awaits = pageList('AWAITS_HANDOVER');
  assert.ok(!awaits.includes('tl_changes_requested'),
    'the page must not make the artist wait for a relay');
  const serverAwaits = SRC('routes/assets.js');
  const block = serverAwaits.slice(serverAwaits.indexOf('const AWAITING_HANDOVER = {'));
  assert.ok(!block.slice(0, block.indexOf('};')).includes('tl_changes_requested'),
    'and neither does the server');
});

test('asking for changes creates no round, on either path', () => {
  /* A ROUND IS A SUBMISSION in this application — reports count asset_versions
     rows, see the rounds sub-select in src/routes/reports.js — so neither of the
     two ways of asking for changes creates one, and the artist's resubmission
     creates exactly one whichever asked. That is what makes double counting
     impossible rather than merely unlikely: there is nothing to count twice.
     Asserted on the source of the query, because the invariant is the query. */
  const reports = SRC('routes/reports.js');
  const rounds = reports.match(/\(SELECT COUNT\(\*\) FROM (\w+) v WHERE v\.asset_id = a\.id\) AS rounds/);
  assert.ok(rounds, 'the rounds figure is still a count of one table');
  assert.strictEqual(rounds[1], 'asset_versions',
    'a round is a submission; if this becomes an event count, both feedback paths would count');

  /* And no route on either path writes a version row. The submit route does,
     which is the whole point. */
  const assets = SRC('routes/assets.js');
  const feedbackRoute = assets.slice(assets.indexOf("router.post('/:id/submit-feedback'"));
  const body = feedbackRoute.slice(0, feedbackRoute.indexOf("router.post('/:id/send-to-client'"));
  assert.ok(!/INSERT INTO asset_versions/.test(body),
    'submitting feedback writes no version row, so it counts no round');
  assert.ok(/INSERT INTO feedback/.test(body),
    'it writes the feedback row the artist reads');
});

// ===========================================================================
// 4. AGAINST A LIVE SERVER: the loop, walked end to end.
// ===========================================================================

test('the whole loop, against the real server', { skip: cfg ? false : SKIP_REASON },
  async (t) => {
  let server;
  const tok = {};
  const id = {};
  const as = (who, p, o = {}) => api(server.base, p, { ...o, token: tok[who] });
  const login = async (email) => (await api(server.base, '/auth/login',
    { method: 'POST', body: { email, password: PASSWORD } })).body.token;
  const statusOf = async (assetId) => (await as('root', `/assets/${assetId}/history`)).body.status;
  const historyOf = async (assetId) => (await as('root', `/assets/${assetId}/history`)).body.events;
  const card = async (who, assetId) => {
    const r = await as(who, `/assets/project/${id.project}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return r.body.assets.find((a) => a.id === assetId);
  };
  const rounds = async (assetId) => Number((await sql(cfg,
    'SELECT COUNT(*) AS n FROM asset_versions WHERE asset_id = ?', [assetId]))[0].n);
  const feedbackRows = async (assetId) => sql(cfg,
    'SELECT stage, decision, `text`, given_by FROM feedback WHERE asset_id = ? ORDER BY created_at, `text`',
    [assetId]);

  const SAID = 'The rim light on the hero reads flat — raise it and re-render the turntable.';

  /* An asset the lead has approved, every step through its own route — so the
     state under test is one the application really makes. */
  let made = 0;
  const atTlApproved = async (name) => {
    const r = await as('root', `/assets/project/${id.project}`, { method: 'POST',
      body: { name: name || `Shot ${made += 1}`, type: 'prop', assigneeId: id.ana } });
    const assetId = r.body.asset.id;
    await as('ana', `/assets/${assetId}/start`, { method: 'POST' });
    const s = await as('ana', `/assets/${assetId}/submit`, { method: 'POST',
      body: { link: 'https://example.com/v1' } });
    assert.strictEqual(s.status, 201, JSON.stringify(s.body));
    const approved = await as('lead', `/assets/${assetId}/review`, { method: 'POST',
      body: { decision: 'approved' } });
    assert.strictEqual(approved.status, 200, JSON.stringify(approved.body));
    assert.strictEqual(await statusOf(assetId), 'tl_approved', 'setup');
    return assetId;
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'tlfb', WORK_HOURS_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'tlfb', name: 'Root', email: 'root@tlfb.test', password: PASSWORD } });
    tok.root = await login('root@tlfb.test');
    /* A 24-hour studio with no breaks, so no case here depends on the hour the
       suite runs at — the rework's clock has to be able to run. */
    await openStudio(server.base, tok.root);

    const mk = async (key, role, extra = {}) => {
      const r = await as('root', '/users', { method: 'POST',
        body: { name: key, email: `${key}@tlfb.test`, role, password: PASSWORD, ...extra } });
      assert.strictEqual(r.status, 201, `${role}: ${JSON.stringify(r.body)}`);
      id[key] = r.body.user.id;
      tok[key] = await login(`${key}@tlfb.test`);
      return r.body.user.id;
    };
    await mk('lead', 'team_lead');
    await mk('other', 'team_lead');          // a lead on no project of ours
    await mk('ana', 'game_artist', { teamLeadId: id.lead });
    const clients = await as('root', '/clients');
    id.client = clients.body.clients[0].id;
    const pr = await as('root', '/projects', { method: 'POST',
      body: { name: 'Gatehouse', clientId: id.client, teamLeadIds: [id.lead] } });
    id.project = pr.body.project.id;
    const other = await as('root', '/projects', { method: 'POST',
      body: { name: 'Elsewhere', clientId: id.client, teamLeadIds: [id.other] } });
    id.otherProject = other.body.project.id;
  });
  t.after(() => stopServer(server));

  await t.test('THE SCENARIO: approved, sent back, reworked, resubmitted', async () => {
    /* THE REGRESSION TEST THE BRIEF ASKED FOR, in one case and in order, so a
       break anywhere in the loop fails here with the step named. */
    const assetId = await atTlApproved('Hero Prop');
    const roundsBefore = await rounds(assetId);

    // 1. the lead sends it back
    const sent = await as('lead', `/assets/${assetId}/submit-feedback`, { method: 'POST',
      body: { text: SAID } });
    assert.strictEqual(sent.status, 200, JSON.stringify(sent.body));
    assert.strictEqual(sent.body.asset.status, 'tl_changes_requested',
      'the response carries the moved asset, so the card can move without a reload');
    assert.strictEqual(sent.body.asset.routed_to_id, id.ana, 'routed to the artist');
    assert.strictEqual(await statusOf(assetId), 'tl_changes_requested');
    assert.strictEqual(await rounds(assetId), roundsBefore,
      'asking for changes is not a round');

    // 2. the feedback is stored where the artist already reads it
    const rows = await feedbackRows(assetId);
    const mine = rows.filter((r) => r.text === SAID);
    assert.strictEqual(mine.length, 1, `one feedback row: ${JSON.stringify(rows)}`);
    assert.strictEqual(mine[0].stage, 'tl');
    assert.strictEqual(mine[0].decision, 'changes_requested');
    assert.strictEqual(mine[0].given_by, id.lead);

    // 3. and the history says who and what
    const events = await historyOf(assetId);
    const event = events.find((e) => e.action === 'tl_submit_feedback');
    assert.ok(event, `the event is in the history: ${events.map((e) => e.action)}`);
    assert.strictEqual(event.note, SAID, 'the whole feedback is on the event row');
    assert.strictEqual(event.fromLabel, 'TL Approved');
    assert.strictEqual(event.toLabel, 'TL Feedbacks');

    // 4. the artist sees it
    const seen = await card('ana', assetId);
    assert.ok(seen, 'the asset is on the artist\'s board');
    assert.ok((seen.feedback || []).some((f) => f.text === SAID),
      'and the feedback travels with it, which is what the drawer reads');

    // 5. the artist can start the clock and submit the rework
    const started = await as('ana', `/assets/${assetId}/start`, { method: 'POST' });
    assert.strictEqual(started.status, 200, JSON.stringify(started.body));
    await sql(cfg,
      'UPDATE work_sessions SET started_at = DATE_SUB(NOW(), INTERVAL 45 MINUTE) '
      + 'WHERE asset_id = ? AND ended_at IS NULL', [assetId]);
    const again = await as('ana', `/assets/${assetId}/submit`, { method: 'POST',
      body: { link: 'https://example.com/v2' } });
    assert.strictEqual(again.status, 201, JSON.stringify(again.body));
    assert.strictEqual(await statusOf(assetId), 'pending_tl_review',
      'the rework goes back to the gate it came from');
    assert.strictEqual(await rounds(assetId), roundsBefore + 1,
      'and the resubmission is exactly one new round');

    // 6. the rework's time was recorded against it
    const recorded = Number((await sql(cfg,
      'SELECT COALESCE(SUM(seconds),0) AS s FROM work_sessions WHERE asset_id = ? AND user_id = ?',
      [assetId, id.ana]))[0].s);
    assert.ok(recorded > 0, `the rework was clocked, not recorded as nothing (${recorded}s)`);

    // 7. and the two old buttons still work on the next pass
    const reapproved = await as('lead', `/assets/${assetId}/review`, { method: 'POST',
      body: { decision: 'approved' } });
    assert.strictEqual(reapproved.status, 200, JSON.stringify(reapproved.body));
    assert.strictEqual(await statusOf(assetId), 'tl_approved');
    const onward = await as('lead', `/assets/${assetId}/send-to-cd`, { method: 'POST', body: {} });
    assert.strictEqual(onward.status, 200, JSON.stringify(onward.body));
    assert.strictEqual(await statusOf(assetId), 'pending_cd_review');
  });

  await t.test('the board says per asset whether the button should be drawn', async () => {
    const assetId = await atTlApproved();
    const forLead = await card('lead', assetId);
    assert.strictEqual(forLead.feedback_state.canSubmit, true,
      'the lead on this project is offered it');
    assert.strictEqual(forLead.feedback_state.minLength, tlFeedback.MIN_LENGTH,
      'and the limits travel with the answer, so the counter cannot disagree');
    assert.strictEqual(forLead.feedback_state.maxLength, tlFeedback.MAX_LENGTH);

    const forArtist = await card('ana', assetId);
    assert.strictEqual(forArtist.feedback_state.canSubmit, false, 'the artist is not');
    assert.strictEqual(forArtist.feedback_state.submit.code, tlFeedback.CODES.NO_PERMISSION);
    assert.strictEqual(forArtist.feedback_state.submit.offer, false,
      'and nothing is drawn for them at all');

    /* A STAGE THAT IS NOT TL APPROVED answers with the stage, and is not offered
       — so the button is absent rather than greyed everywhere in the pipeline. */
    await as('lead', `/assets/${assetId}/send-to-cd`, { method: 'POST', body: {} });
    const moved = await card('lead', assetId);
    assert.strictEqual(moved.feedback_state.canSubmit, false);
    assert.strictEqual(moved.feedback_state.submit.code, tlFeedback.CODES.WRONG_STATUS);
    assert.match(moved.feedback_state.submit.message, /no longer in TL Approved/);
  });

  await t.test('the feedback is required, and held to its limits', async () => {
    const assetId = await atTlApproved();
    for (const [text, why] of [[undefined, 'missing'], ['', 'empty'], ['   \n\t ', 'whitespace'],
      ['too short', 'under the minimum']]) {
      const r = await as('lead', `/assets/${assetId}/submit-feedback`, { method: 'POST',
        body: text === undefined ? {} : { text } });
      assert.strictEqual(r.status, 400, `${why}: ${JSON.stringify(r.body)}`);
      assert.strictEqual(r.body.field, 'text');
      assert.strictEqual(await statusOf(assetId), 'tl_approved', `${why}: nothing moved`);
    }
    const long = await as('lead', `/assets/${assetId}/submit-feedback`, { method: 'POST',
      body: { text: 'x'.repeat(tlFeedback.MAX_LENGTH + 1) } });
    assert.strictEqual(long.status, 400, JSON.stringify(long.body));
    assert.match(long.body.error, new RegExp(String(tlFeedback.MAX_LENGTH)));
    assert.strictEqual(await statusOf(assetId), 'tl_approved');
    assert.strictEqual((await feedbackRows(assetId)).filter((r) => r.text).length, 0,
      'and a refused submission stores no feedback row');
  });

  await t.test('refused from every other status, on the real routes', async () => {
    /* The pure matrix above covers the table; this covers the ROUTE, which has
       its own conflict answer before the table is reached. */
    const assetId = await atTlApproved();
    await as('lead', `/assets/${assetId}/send-to-cd`, { method: 'POST', body: {} });
    const r = await as('lead', `/assets/${assetId}/submit-feedback`, { method: 'POST',
      body: { text: SAID } });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, tlFeedback.CODES.WRONG_STATUS);
    assert.match(r.body.error, /no longer in TL Approved/);
    assert.strictEqual(await statusOf(assetId), 'pending_cd_review', 'and nothing moved');

    /* A fresh asset in Not Assigned — the other end of the pipeline. */
    const fresh = (await as('root', `/assets/project/${id.project}`, { method: 'POST',
      body: { name: 'Never Started', type: 'prop' } })).body.asset.id;
    const early = await as('lead', `/assets/${fresh}/submit-feedback`, { method: 'POST',
      body: { text: SAID } });
    assert.strictEqual(early.status, 409, JSON.stringify(early.body));
    assert.strictEqual(early.body.code, tlFeedback.CODES.WRONG_STATUS);
  });

  await t.test('a lead with no reach into the project is refused', async () => {
    const assetId = await atTlApproved();
    const r = await as('other', `/assets/${assetId}/submit-feedback`, { method: 'POST',
      body: { text: SAID } });
    assert.strictEqual(r.status, 403, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, tlFeedback.CODES.NOT_ON_GATE);
    assert.strictEqual(await statusOf(assetId), 'tl_approved');
  });

  await t.test('the permission governs, and a grant takes effect on the same token', async () => {
    /* NO SIGN-OUT. The page re-polls /auth/me every twenty seconds and the
       server reads the role's permissions per request, so a Super Admin's grant
       reaches a lead who is already signed in. Asserted on ONE token across the
       revoke and the grant, which is the claim. */
    const held = async () => (await as('root', '/permissions/roles/team_lead')).body.role
      .permissions.filter((p) => p.enabled).map((p) => p.key);
    const set = async (keys) => {
      const r = await as('root', '/permissions/roles/team_lead', { method: 'PUT',
        body: { permissions: keys } });
      assert.ok(r.status < 400, JSON.stringify(r.body));
    };
    const all = await held();
    assert.ok(all.includes('review.tl_feedback'),
      'a Team Lead holds it by default — the decision pinned in the defaults test');

    await set(all.filter((k) => k !== 'review.tl_feedback'));
    const denied = await atTlApproved();
    const no = await as('lead', `/assets/${denied}/submit-feedback`, { method: 'POST',
      body: { text: SAID } });
    assert.strictEqual(no.status, 403, JSON.stringify(no.body));
    assert.strictEqual(no.body.code, tlFeedback.CODES.NO_PERMISSION);
    assert.match(no.body.error, /TL Submit Feedback/, 'and it names the key to grant');
    /* The board agrees, on the same token: the button is not drawn at all. */
    const hidden = await card('lead', denied);
    assert.strictEqual(hidden.feedback_state.canSubmit, false);
    assert.strictEqual(hidden.feedback_state.submit.offer, false);
    /* AND THE NEIGHBOURING BUTTON IS UNTOUCHED, which is what a separate key
       buys: the lead can still send the approved work onward. */
    const onward = await as('lead', `/assets/${denied}/send-to-cd`, { method: 'POST', body: {} });
    assert.strictEqual(onward.status, 200, JSON.stringify(onward.body));

    await set(all);
    const allowed = await atTlApproved();
    const yes = await as('lead', `/assets/${allowed}/submit-feedback`, { method: 'POST',
      body: { text: SAID } });
    assert.strictEqual(yes.status, 200, JSON.stringify(yes.body));
    assert.strictEqual(await statusOf(allowed), 'tl_changes_requested');
  });

  await t.test('a second submit is a conflict, not a second round', async () => {
    /* TWO LEADS WITH THE PANEL OPEN, one of them clicks first. The second must
       be told the stage has moved rather than write a second feedback row over
       work that is already with the artist. */
    const assetId = await atTlApproved();
    const first = await as('lead', `/assets/${assetId}/submit-feedback`, { method: 'POST',
      body: { text: SAID } });
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));

    const second = await as('lead', `/assets/${assetId}/submit-feedback`, { method: 'POST',
      body: { text: 'And the shadow is too hard on the left' } });
    assert.strictEqual(second.status, 409, JSON.stringify(second.body));
    assert.strictEqual(second.body.code, tlFeedback.CODES.WRONG_STATUS);
    assert.strictEqual((await feedbackRows(assetId)).filter((r) => r.text).length, 1,
      'one feedback row, not two');
    const events = await historyOf(assetId);
    assert.strictEqual(events.filter((e) => e.action === 'tl_submit_feedback').length, 1,
      'and one event');
  });

  await t.test('an unassigned asset is refused, with the reason', async () => {
    const assetId = await atTlApproved();
    await sql(cfg, 'UPDATE assets SET assignee_id = NULL WHERE id = ?', [assetId]);
    const r = await as('lead', `/assets/${assetId}/submit-feedback`, { method: 'POST',
      body: { text: SAID } });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, tlFeedback.CODES.UNASSIGNED);
    assert.match(r.body.error, /nobody assigned/);
    assert.strictEqual(await statusOf(assetId), 'tl_approved',
      'because TL Feedbacks sits on a desk, and there is no desk to put it on');
    /* AND THE BOARD SAYS SO, offered-but-inert: the lead can see the task and
       the reason is something they can act on. */
    const row = await card('lead', assetId);
    assert.strictEqual(row.feedback_state.canSubmit, false);
    assert.strictEqual(row.feedback_state.submit.offer, true);
  });

  await t.test('an outsourced asset is refused, and names the freelancer', async () => {
    const assetId = await atTlApproved();
    const f = await as('root', '/outsource/freelancers', { method: 'POST',
      body: { name: 'Fran Freelance', discipline: 'art' } });
    /* The real shape: the app clears the internal assignee before sending work
       out, so the task has no artist to send feedback to either way. */
    await sql(cfg, 'UPDATE assets SET assignee_id = NULL WHERE id = ?', [assetId]);
    const sent = await as('root', '/outsource/assignments', { method: 'POST',
      body: { freelancerId: f.body.freelancer.id, projectId: id.project, assetId,
        decidedManHours: 8 } });
    assert.strictEqual(sent.status, 201, JSON.stringify(sent.body));

    const r = await as('lead', `/assets/${assetId}/submit-feedback`, { method: 'POST',
      body: { text: SAID } });
    assert.strictEqual(r.status, 409, JSON.stringify(r.body));
    assert.strictEqual(r.body.code, tlFeedback.CODES.OUTSOURCED,
      'the freelancer is named rather than "nobody is assigned"');
    assert.match(r.body.error, /out with Fran Freelance/);
    assert.strictEqual(await statusOf(assetId), 'tl_approved');
    const row = await card('lead', assetId);
    assert.strictEqual(row.feedback_state.submit.code, tlFeedback.CODES.OUTSOURCED,
      'and the board can explain it the same way');
  });

  await t.test('the artist is told, exactly once', async () => {
    const assetId = await atTlApproved();
    /* FILTERED TO THIS KIND, and the filter is the lesson: the artist already
       has an `assigned` notification for this asset, because setting the work up
       raised one. Counting every row would have been counting the fixture. */
    const mine = async () => (await as('ana', '/notifications')).body.notifications
      .filter((n) => n.assetId === assetId && n.kind === 'changes_requested');
    assert.strictEqual((await mine()).length, 0, 'nothing of this kind yet');

    await as('lead', `/assets/${assetId}/submit-feedback`, { method: 'POST', body: { text: SAID } });
    const after = await mine();
    assert.strictEqual(after.length, 1, `one notification: ${JSON.stringify(after)}`);
    assert.strictEqual(after[0].kind, 'changes_requested');
    assert.match(after[0].message, /back with changes/);
    assert.ok(!after[0].message.includes('rim light'),
      'and it does not put the feedback on a lock screen');

    /* A SECOND ATTEMPT RAISES NOTHING, because it is refused — so the count is a
       property of the transition rather than of how many times somebody clicks. */
    await as('lead', `/assets/${assetId}/submit-feedback`, { method: 'POST', body: { text: SAID } });
    assert.strictEqual((await mine()).length, 1, 'still one');
  });

  await t.test('a lead sending their own work back is not told by themselves', async () => {
    /* A lead can be an assignee — `assignable` and `leadsTeam` are held together
       by some designations — and raise() drops a recipient who is also the
       actor. Here the asset is the ARTIST's, and root (full access) sends it
       back, so the artist is told and root is not. */
    const assetId = await atTlApproved();
    await as('root', `/assets/${assetId}/submit-feedback`, { method: 'POST', body: { text: SAID } });
    /* Of THIS kind. root already holds a `submitted` row for this asset — they
       set the work up, and taskSubmitted tells whoever assigned it. */
    const ofKind = async (who) => (await as(who, '/notifications')).body.notifications
      .filter((n) => n.assetId === assetId && n.kind === 'changes_requested');
    assert.strictEqual((await ofKind('root')).length, 0, 'the actor is not notified');
    assert.strictEqual((await ofKind('ana')).length, 1, 'the artist is');
  });
});

// ===========================================================================
// 5. THE PAGE, RUN RATHER THAN READ.
// ===========================================================================

/* A DOM the page's own code can run against, with the three native dialogs
 * passed in THROWING — which is what the desktop application does. The same
 * arrangement as tests/dialog-flow.test.js, kept local to this suite because the
 * element list is this feature's: that file's stub knows about the hold buttons
 * and this one has to know about the textarea and the counter.
 *
 * WHAT IS BEING TESTED IS THE PAGE'S CODE, not a copy of it: both slices are cut
 * out of public/index.html at run time, with their boundaries asserted — a
 * silently empty slice would make every case below pass for the wrong reason.
 */
function makeDom() {
  const nodes = new Map();
  const make = (id) => {
    const el = {
      id,
      textContent: '', value: '', placeholder: '', className: '', type: '',
      disabled: false, readOnly: false, tagName: id === 'ask_textarea' ? 'TEXTAREA' : 'DIV',
      style: {}, _attrs: {}, _classes: new Set(),
      classList: {
        add: (c) => el._classes.add(c),
        remove: (...c) => c.forEach((x) => el._classes.delete(x)),
        contains: (c) => el._classes.has(c),
      },
      focus() { el._focused = true; },
      select() { el._selected = true; },
      onclick: null, oninput: null,
      click() { if (el.onclick) return el.onclick({ target: el }); return undefined; },
      /* Typing, as the field sees it: set the value and fire the handler openAsk
         attached, which is what re-decides the confirm button and the counter. */
      type_(text) { el.value = text; if (el.oninput) el.oninput({ target: el }); },
      setAttribute(k, v) { el._attrs[k] = v; },
      getAttribute: (k) => (k in el._attrs ? el._attrs[k] : null),
      removeAttribute(k) { delete el._attrs[k]; },
      querySelector: () => null, querySelectorAll: () => [],
      appendChild() {}, remove() {},
    };
    return el;
  };
  for (const id of ['askWrap', 'ask_title', 'ask_message', 'ask_field', 'ask_label',
    'ask_input', 'ask_textarea', 'ask_count', 'ask_err', 'ask_confirm', 'ask_cancel',
    'tlFeedbackBtn', 'toast']) nodes.set(id, make(id));

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
  return { document, nodes, key };
}

function feedbackHarness({ api: apiFn, asset, toast = [], updates = [], closed = [] } = {}) {
  const dialogFrom = PAGE.indexOf("const askWrap = document.getElementById('askWrap');");
  const dialogTo = PAGE.indexOf('/* ---------- login/session ----------');
  assert.ok(dialogFrom !== -1 && dialogTo > dialogFrom, 'the shared dialog is in the page');
  const dialog = PAGE.slice(dialogFrom, dialogTo);
  assert.match(dialog, /function openAsk\(\{/, 'and the slice contains it');

  /* CUT AT THE NEXT THING IN THE FILE, not at a closing brace: '    });' is a
     substring of the inner '      });' that closes openAsk, so searching for it
     silently cut the handler in half and every case below failed to parse. */
  const from = PAGE.indexOf("    const feedbackBtn = document.getElementById('tlFeedbackBtn');");
  const to = PAGE.indexOf('    /* Skipping the CD gate.', from);
  assert.ok(from !== -1 && to > from, 'the Submit Feedback handler is in the page');
  const handler = PAGE.slice(from, to);
  assert.match(handler, /await openAsk\(\{/, 'and it asks through the shared dialog');
  assert.match(handler, /submit-feedback/, 'and sends to the route');

  const dom = makeDom();
  const calls = [];
  const api = async (p, o = {}) => {
    calls.push({ path: p, method: (o && o.method) || 'GET', body: o && o.body });
    return apiFn(p, o);
  };
  const notSupported = (name) => () => { throw new Error(`${name}() is not supported.`); };

  const built = new Function(
    'document', 'window', 'api', 'a', 'id', 'statusOf', 'applyAssetUpdate', 'closeDrawer',
    'showToast', 'UNKNOWN_FEEDBACK_STATE', 'prompt', 'confirm', 'alert', 'console',
    `${dialog}\n${handler}\n return { activeQuestion: () => askActive };`
  )(
    dom.document,
    { addEventListener: (t, fn) => dom.document.addEventListener(t, fn),
      prompt: notSupported('prompt'), confirm: notSupported('confirm'),
      alert: notSupported('alert') },
    api, asset, asset.id,
    (s) => ({ label: s === 'tl_changes_requested' ? 'TL Feedbacks' : s }),
    (updated) => { updates.push(updated); return true; },
    () => closed.push(true),
    (m) => toast.push(m),
    { canSubmit: false, minLength: 12, maxLength: 2000,
      submit: { code: 'TLFB_UNKNOWN', offer: true, message: 'unknown' } },
    notSupported('prompt'), notSupported('confirm'), notSupported('alert'),
    { error() {}, warn() {} },
  );
  return { ...built, dom, calls, toast, updates, closed };
}

const ASSET = { id: 'asset-1', code: 'FX-001', status: 'tl_approved',
  feedback_state: { canSubmit: true, minLength: tlFeedback.MIN_LENGTH,
    maxLength: tlFeedback.MAX_LENGTH, submit: { code: null, offer: true, message: null } } };
const GOOD = 'Raise the rim light and re-render';

test('the page: the modal opens, validates, and sends only what is valid', async () => {
  const h = feedbackHarness({ asset: ASSET, api: async () => ({ asset: { ...ASSET, status: 'tl_changes_requested' } }) });
  const confirm = h.dom.nodes.get('ask_confirm');
  const area = h.dom.nodes.get('ask_textarea');
  const count = h.dom.nodes.get('ask_count');

  h.dom.nodes.get('tlFeedbackBtn').click();
  await Promise.resolve();
  assert.ok(h.dom.nodes.get('askWrap').classList.contains('show'), 'the question is on screen');
  assert.strictEqual(h.dom.nodes.get('ask_input').style.display, 'none',
    'the one-line field is put away');
  assert.strictEqual(area.style.display, '', 'and the text area is shown');
  assert.strictEqual(area.getAttribute('maxlength'), String(tlFeedback.MAX_LENGTH),
    'the browser stops the typing at the limit too');

  /* DISABLED UNTIL IT IS VALID, and the counter says what is missing. */
  assert.strictEqual(confirm.disabled, true, 'nothing can be sent yet');
  assert.match(count.textContent, /more characters? needed/);
  assert.deepStrictEqual(h.calls, [], 'and nothing has been sent');

  area.type_('short');
  assert.strictEqual(confirm.disabled, true, 'still too short');
  area.type_('                    ');
  assert.strictEqual(confirm.disabled, true, 'and whitespace is not length');

  area.type_(GOOD);
  assert.strictEqual(confirm.disabled, false, 'now it can be sent');
  assert.match(count.textContent, new RegExp(`${GOOD.length} / ${tlFeedback.MAX_LENGTH}`),
    'and the counter counts up to the limit');

  await confirm.click();
  assert.deepStrictEqual(h.calls, [{ path: '/assets/asset-1/submit-feedback',
    method: 'POST', body: { text: GOOD } }], 'one request, with the text');
});

test('the page: the card moves on success, with no reload', async () => {
  const moved = { ...ASSET, status: 'tl_changes_requested', routed_to_id: 'ana' };
  const h = feedbackHarness({ asset: ASSET, api: async () => ({ asset: moved }) });
  h.dom.nodes.get('tlFeedbackBtn').click();
  await Promise.resolve();
  h.dom.nodes.get('ask_textarea').type_(GOOD);
  await h.dom.nodes.get('ask_confirm').click();

  /* THE SERVER'S OWN COPY OF THE ASSET goes into state, so the card is in TL
     Feedbacks before anything else happens — no second fetch, no render(). */
  assert.deepStrictEqual(h.updates, [moved], 'the card is updated from the response');
  assert.deepStrictEqual(h.closed, [true], 'the drawer closes');
  assert.ok(!h.dom.nodes.get('askWrap').classList.contains('show'), 'and the question with it');
  assert.ok(h.toast.some((m) => /TL Feedbacks/.test(m)), `and the person is told: ${h.toast}`);
  /* NO RELOAD AND NO REFETCH — asserted on the page's source, because the
     absence of a call is not visible in the harness. */
  const at = PAGE.indexOf("const feedbackBtn = document.getElementById('tlFeedbackBtn');");
  const handler = PAGE.slice(at, PAGE.indexOf('    /* Skipping the CD gate.', at));
  assert.ok(!/\brender\(\)/.test(handler), 'the handler does not re-render the whole tab');
  assert.ok(!/location\.reload/.test(handler), 'and nothing reloads');
  assert.match(handler, /applyAssetUpdate\(updated\)/);
});

test('the page: a refusal is visible, and the typed text is kept', async () => {
  const h = feedbackHarness({ asset: ASSET, api: async () => {
    const err = new Error('FX-001 is no longer in TL Approved — it is in CD Review.');
    err.status = 409;
    throw err;
  } });
  h.dom.nodes.get('tlFeedbackBtn').click();
  await Promise.resolve();
  const area = h.dom.nodes.get('ask_textarea');
  area.type_(GOOD);
  await h.dom.nodes.get('ask_confirm').click();

  assert.ok(h.dom.nodes.get('askWrap').classList.contains('show'),
    'the question stays up, so the answer is not lost');
  assert.match(h.dom.nodes.get('ask_err').textContent, /no longer in TL Approved/,
    'with the server\'s own reason inside it');
  assert.strictEqual(area.value, GOOD, 'and the typed feedback is still there');
  assert.strictEqual(h.dom.nodes.get('ask_confirm').disabled, false, 'the button is live again');
  assert.deepStrictEqual(h.updates, [], 'nothing moved');
  assert.deepStrictEqual(h.closed, [], 'and nothing closed');
});

test('the page: cancel sends nothing, and Escape is cancel', async () => {
  const h = feedbackHarness({ asset: ASSET, api: async () => { throw new Error('must not be called'); } });
  h.dom.nodes.get('tlFeedbackBtn').click();
  await Promise.resolve();
  h.dom.nodes.get('ask_textarea').type_(GOOD);
  h.dom.nodes.get('ask_cancel').click();
  assert.deepStrictEqual(h.calls, [], 'cancel sends nothing');
  assert.ok(!h.dom.nodes.get('askWrap').classList.contains('show'));
  assert.deepStrictEqual(h.updates, [], 'and nothing moved');

  const again = feedbackHarness({ asset: ASSET, api: async () => { throw new Error('must not be called'); } });
  again.dom.nodes.get('tlFeedbackBtn').click();
  await Promise.resolve();
  again.dom.nodes.get('ask_textarea').type_(GOOD);
  const ev = again.dom.key('Escape');
  assert.ok(ev.defaulted, 'Escape is handled');
  assert.deepStrictEqual(again.calls, [], 'and sends nothing');

  /* ENTER INSIDE THE TEXT AREA IS A NEW LINE, not a submit — feedback is
     several sentences, and a stage that moves on the first Return is a trap. */
  const third = feedbackHarness({ asset: ASSET, api: async () => ({ asset: ASSET }) });
  third.dom.nodes.get('tlFeedbackBtn').click();
  await Promise.resolve();
  third.dom.nodes.get('ask_textarea').type_(GOOD);
  third.dom.key('Enter', third.dom.nodes.get('ask_textarea'));
  await Promise.resolve();
  assert.deepStrictEqual(third.calls, [], 'Enter in the box did not send it');
});

test('the page: a double click is one request', async () => {
  let release;
  const h = feedbackHarness({ asset: ASSET, api: () => new Promise((r) => {
    release = () => r({ asset: { ...ASSET, status: 'tl_changes_requested' } });
  }) });
  h.dom.nodes.get('tlFeedbackBtn').click();
  await Promise.resolve();
  h.dom.nodes.get('ask_textarea').type_(GOOD);

  const confirm = h.dom.nodes.get('ask_confirm');
  const first = confirm.click();
  await Promise.resolve();
  assert.strictEqual(confirm.textContent, 'Sending…', 'the button says what it is doing');
  assert.strictEqual(confirm.disabled, true, 'and cannot be pressed twice');
  assert.strictEqual(h.dom.nodes.get('ask_cancel').disabled, true,
    'the way out is closed while the request is in flight');

  await confirm.click();           // the second click, which must do nothing
  release();
  await first;
  assert.strictEqual(h.calls.length, 1, `one request, not two: ${JSON.stringify(h.calls)}`);
});

test('the page: no native dialog is reachable from this path', () => {
  /* The three are passed in throwing, so every case above would have failed if
     the handler reached for one. This pins the absence directly as well, because
     a future edit might add one on a branch no case exercises — and in the
     desktop application prompt() throws, which is how the Hold button came to
     "do nothing" there. */
  const at = PAGE.indexOf("const feedbackBtn = document.getElementById('tlFeedbackBtn');");
  const handler = PAGE.slice(at, PAGE.indexOf('    /* Skipping the CD gate.', at));
  const code = handler.replace(/\/\*[\s\S]*?\*\//g, '');
  for (const native of ['prompt(', 'confirm(', 'alert(']) {
    assert.ok(!code.includes(native), `the handler must not call ${native}`);
  }
  assert.match(code, /openAsk\(\{/, 'it uses the page\'s own modal');
});
