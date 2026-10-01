/* A game bug is a rework stage, and now behaves like one all the way through.
 *
 * Three gaps, found by walking the flow in tests/game-feedback-panel.test.js and recorded
 * there as failing-on-purpose assertions until they were closed. All three were the same
 * shape: game_feedback had been added to a list somewhere and left out of the gate beside
 * it, so the move existed and nobody could make it.
 *
 *   1. `submit` had no transition from game_feedback, although the note on
 *      game_feedback_pass says "the artist's next submit is the new round". An artist
 *      handed a bug to fix had no move of their own.
 *   2. `reassign_review` DID list game_feedback, but canHandOverInReview had no case for
 *      it — so the transition existed, the screen offered the stage, and the gate refused
 *      everybody except asset.assign_any, the creator, and full access. Not the lead who
 *      had just passed the bug on.
 *   3. public/index.html's REWORK_STATUSES held two values where the server held three.
 *      That one had to be fixed LAST: it gates the "Reassign to Same User" shortcut, which
 *      goes through the transition (2) was refusing, so aligning it first would have put
 *      a button on screen that answered 403.
 *
 * WHAT IS GUARDED HERE is not that the three lists contain a string — a grep would do
 * that, and would keep passing when the gate beside the list stopped agreeing. It is that
 * the round behaves like every other round: a version row, a work session closed against
 * it, the reviewer it belongs to, and the Efficiency report counting it without being
 * told anything new.
 */
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const workflow = require('../src/asset-workflow');
const { REWORK_STATUSES } = require('../src/permissions');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

const cfg = config('gfrework');
const SECRET = 'inbound-secret-for-the-rework-suite';
const PASSWORD = 'GfRework-Test-1!';
const sha256 = (v) => crypto.createHash('sha256').update(v).digest('hex');
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// --- the three lists, against the gates beside them --------------------------

test('a game bug is on the hand-over path, and the gate beside it agrees', () => {
  /* The pairing that was broken. reassign_review has listed game_feedback since the
     transition was written; what is asserted here is that the permission switch which
     decides who may make it names the status too. Read out of the source rather than by
     calling it, because calling it needs a project, a team and a database — and the bug
     was a missing `case`, which is visible here and cannot be missed. */
  const from = workflow.transitionFor('reassign_review').from;
  assert.ok(from.includes('game_feedback'), `game_feedback is not on the hand-over path: ${from}`);

  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'permissions.js'), 'utf8');
  const at = src.indexOf('async function canHandOverInReview(');
  assert.ok(at !== -1);
  const body = src.slice(at, src.indexOf('\n}\n', at));
  /* Every stage on the transition's from-list must be answered by the switch, not fall
     through to its default. Checked as a set so a stage added to the machine later fails
     here rather than silently becoming unreachable, which is exactly what happened. */
  const answered = [...body.matchAll(/case '([a-z_]+)':/g)].map((m) => m[1]);
  assert.deepStrictEqual([...from].sort(), answered.sort(),
    'every stage work can be handed on from must have a case in canHandOverInReview');
  assert.match(body, /case 'game_feedback':\n\s+return canActAtTlGate/,
    'and a game bug is answered by the gate that decides who may pass or decline it');

  /* AND THE PAGE'S COPY, which is the half a behavioural test cannot see: the server
     would allow the hand-over, so removing this line takes the button off the screen and
     nothing fails. HAND_OVER_STATUSES already lists the stage, so without it the panel
     draws the stage and withholds the control — the exact state this fix came out of,
     reintroduced silently. */
  const fn = PAGE.match(/function mayHandOverInReview\(a\)\{([\s\S]*?)\n\}/);
  assert.ok(fn, 'the page has no mayHandOverInReview');
  assert.match(fn[1], /a\.status === 'game_feedback'\) return mayActAtTlGate\(a\)/,
    'the page asks the same gate for a game bug as the server does');
});

test('the page offers the rework shortcut only where the server would honour it', () => {
  /* GAP 3, and the ordering constraint in one assertion.
   *
   * The page's REWORK_STATUSES gates the "Reassign to Same User" shortcut, which goes
   * through reassign_review. So every status in it has to be a status that transition
   * accepts — otherwise the page offers a button the API refuses, which is the state the
   * alignment would have created if it had been done before the gate was fixed. */
  const list = PAGE.match(/const REWORK_STATUSES = \[([^\]]*)\];/);
  assert.ok(list, 'public/index.html has no REWORK_STATUSES');
  const inPage = [...list[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(inPage.sort(), [...REWORK_STATUSES].sort(),
    'the page and src/permissions.js must park rework in the same states');

  const handOver = workflow.transitionFor('reassign_review').from;
  for (const status of inPage) {
    assert.ok(handOver.includes(status),
      `${status} is offered the rework shortcut but is not a stage reassign_review accepts`);
  }

  // And the stage list the control itself is drawn from agrees with the machine.
  const stages = PAGE.match(/const HAND_OVER_STATUSES = \[([\s\S]*?)\];/);
  const inStages = [...stages[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(inStages.sort(), [...handOver].sort());
});

test('the page offers Submit exactly where the machine accepts one', () => {
  /* The other half of gap 1: the transition without the button is an artist who can
     submit through the API and has nothing to click. Both halves are read off their
     sources and compared, so neither can move on its own.

     'assigned' is in the page's list and not the machine's, deliberately and with a
     comment there: the section is drawn so the artist can see what submitting will ask
     for, and the button is disabled until the work has been started. */
  const list = PAGE.match(/const canSubmit = [\s\S]*?\[([\s\S]*?)\]\.includes\(a\.status\)/);
  assert.ok(list, 'could not find the canSubmit status list');
  const inPage = [...list[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);

  const accepts = workflow.TRANSITIONS
    .filter((t) => t.action === 'submit').flatMap((t) => t.from);
  assert.deepStrictEqual(inPage.sort(), [...accepts, 'assigned'].sort(),
    'the page draws Submit on every stage the machine accepts one from, plus Assigned');
  assert.ok(inPage.includes('game_feedback'), 'game feedback among them');
  assert.ok(!accepts.includes('assigned'), 'and Assigned is still refused by the machine');
});

test('the clock may run on a game bug, on the page and on the server alike', () => {
  /* The half of gap 1 that was nearly missed. The submit transition alone would have let
     an artist hand a fix in with no way to record the work, and a round in this application
     IS a submission — so the Efficiency report would have counted a round with no hours,
     under-reporting exactly the work Game Feedback tracks.
     
     Both lists are read off their sources and compared, so neither can move alone. */
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'assets.js'), 'utf8');
  const server = src.match(/const STARTABLE = \[([\s\S]*?)\];/);
  assert.ok(server, 'src/routes/assets.js has no STARTABLE');
  const onServer = [...server[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.ok(onServer.includes('game_feedback'), `a session cannot be opened on a game bug: ${onServer}`);

  const list = PAGE.match(/const mayStart = [\s\S]*?\[([\s\S]*?)\]\.includes\(a\.status\)/);
  assert.ok(list, 'could not find the page\'s start list');
  const onPage = [...list[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual(onPage.sort(), onServer.sort(),
    'the page offers Accept and Start exactly where the server allows a session');

  /* And both name the two stages that wait to be handed over. A game bug in the queue is
     the lead's to answer; starting work on it would be answering it by the back door. */
  assert.match(src, /const AWAITING_HANDOVER = \{[\s\S]*?game_feedback:/,
    'the server holds a game bug until it is passed on');
  const awaits = PAGE.match(/const AWAITS_HANDOVER = \[([^\]]*)\]/);
  assert.ok(awaits, 'the page has no AWAITS_HANDOVER');
  assert.deepStrictEqual([...awaits[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort(),
    ['cd_changes_requested', 'game_feedback']);
});

test('a game bug submit lands at the first gate, and is the assignee\'s move', () => {
  const t = workflow.TRANSITIONS.find((x) => x.action === 'submit' && x.from.includes('game_feedback'));
  assert.ok(t, 'submit accepts game_feedback');
  assert.strictEqual(t.to, 'pending_tl_review',
    'the gate that answered the bug is where its fix goes back to');
  assert.strictEqual(t.who, 'assignee');
  assert.strictEqual(t.routeTo, 'reviewQueue', 'a queue, like every other submission');
  assert.ok(!t.requiresNote, 'and it needs no note — the bug report is the brief');

  /* ROUTED, NOT MERELY ASSIGNED, and this is what stops an artist answering the bug over
     the lead's head. actors.assignee admits them when the asset is routed to them, or
     when it is unrouted AND the status is one of their own — and game_feedback is
     deliberately not in that second list, so a bug still in the queue is not theirs. */
  assert.ok(!workflow.ASSIGNEE_STATUSES.includes('game_feedback'),
    'game_feedback is not a status the assignee holds by default — only by being routed it');
});

// --- against a live server ---------------------------------------------------

test('the fix, and the hand-over, end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const KEY = 'gfrw-key-0123456789abc';
  const tokens = {};
  const ids = {};

  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: tokens[who] });
  const raise = async (assetId, body = {}) => {
    const payload = JSON.stringify({ source: 'qa', note: 'it clips through the floor',
      bug_ref: `QA-${crypto.randomUUID().slice(0, 8)}`, ...body });
    const stamp = Math.floor(Date.now() / 1000);
    const target = `/api/integration/v1/assets/${assetId}/feedback`;
    const v1 = crypto.createHmac('sha256', SECRET)
      .update(`${stamp}.POST.${target}.${payload}`).digest('hex');
    const res = await fetch(`${server.base}/integration/v1/assets/${assetId}/feedback`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Integration-Key': KEY,
        'X-Integration-Signature': `t=${stamp}, v1=${v1}`,
        'Idempotency-Key': crypto.randomUUID(),
      },
      body: payload,
    });
    /* Read ONCE. The message below used to call res.text() inside the template, which is
       evaluated eagerly — so the body was consumed before res.json() could have it, and
       every case in this file failed with "Body has already been read". */
    const answer = await res.json().catch(() => ({}));
    assert.strictEqual(res.status, 200, `raising the bug: ${JSON.stringify(answer)}`);
    return answer;
  };

  const assetRow = async (assetId) => (await sql(cfg,
    'SELECT `status`, assignee_id AS assignee, routed_to_id AS routed FROM assets WHERE id = ?',
    [assetId]))[0];
  const versions = (assetId) => sql(cfg,
    'SELECT version_number, stage, link, uploaded_by FROM asset_versions WHERE asset_id = ? '
    + 'ORDER BY version_number', [assetId]);
  const sessions = (assetId) => sql(cfg,
    'SELECT round, user_id, ended_reason, seconds FROM work_sessions WHERE asset_id = ? '
    + 'ORDER BY round, started_at', [assetId]);
  const events = (assetId) => sql(cfg,
    'SELECT action, from_status, to_status FROM asset_events WHERE asset_id = ? ORDER BY seq',
    [assetId]);

  /* A delivered asset, which is what makes it idle and so what a bug can pull back in. */
  const delivered = async (name) => {
    const id = crypto.randomUUID();
    await sql(cfg,
      'INSERT INTO assets (id, project_id, `code`, name, type, status, assignee_id, routed_to_id) '
      + 'VALUES (?,?,?,?,?,?,?,NULL)',
      [id, ids.project, `GFR-${id.slice(0, 6)}`, name, 'character', 'delivered', ids.artist]);
    return id;
  };
  /* Raised, then passed to the artist — the state gap 1 was about. */
  const passedToArtist = async (name) => {
    const id = await delivered(name);
    await raise(id);
    const passed = await as('lead', `/assets/${id}/game-feedback`,
      { method: 'POST', body: { decision: 'pass' } });
    assert.strictEqual(passed.status, 200, JSON.stringify(passed.body));
    return id;
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'gfrw-bootstrap',
      INTEGRATION_INBOUND_SECRET: SECRET,
      WORK_HOURS_SWEEP_MINUTES: '0',
    });
    await sql(cfg,
      'INSERT INTO integration_clients (id, `name`, key_hash, key_prefix, allowed_actions, is_active) '
      + 'VALUES (UUID(), ?, ?, ?, ?, 1)',
      ['Dev and QA', sha256(KEY), KEY.slice(0, 8), 'assets,projects']);
    await api(server.base, '/auth/bootstrap', {
      method: 'POST',
      body: { token: 'gfrw-bootstrap', name: 'Root', email: 'root@zvky.test', password: PASSWORD },
    });
    const login = async (email) => (await api(server.base, '/auth/login',
      { method: 'POST', body: { email, password: PASSWORD } })).body.token;
    tokens.root = await login('root@zvky.test');

    const make = async (who, email, role) => {
      const r = await as('root', '/users', {
        method: 'POST', body: { name: who, email, role, password: PASSWORD } });
      assert.strictEqual(r.status, 201, `${role}: ${JSON.stringify(r.body)}`);
      tokens[who] = await login(email);
      return r.body.user.id;
    };
    ids.artist = await make('artist', 'artist@zvky.test', 'game_artist');
    ids.second = await make('second', 'second@zvky.test', 'game_artist');
    ids.lead = await make('lead', 'lead@zvky.test', 'team_lead');
    /* A SECOND LEAD, on the project's review team as well — the person a hand-over would
       go to. On the team, because a lead who is not on it has no standing to receive the
       round in any sense this test could check. */
    ids.otherLead = await make('otherLead', 'other@zvky.test', 'team_lead');
    /* And one who is NOT on the team, to keep the gate honest. */
    ids.stranger = await make('stranger', 'stranger@zvky.test', 'team_lead');

    const client = await as('root', '/clients', { method: 'POST', body: { name: 'Build Co' } });
    const project = await as('root', '/projects', {
      method: 'POST',
      body: { name: 'Shipped Game', clientId: client.body.client.id,
        teamLeadIds: [ids.lead, ids.otherLead] },
    });
    assert.strictEqual(project.status, 201, JSON.stringify(project.body));
    ids.project = project.body.project.id;
  });

  t.after(async () => { if (server) await stopServer(server); });

  /* --- 1: the artist submits the fix --------------------------------------- */

  await t.test('the artist submits the fix, and it is a round like any other', async () => {
    const id = await passedToArtist('Fixable');
    const before = await assetRow(id);
    assert.strictEqual(before.status, 'game_feedback');
    assert.strictEqual(before.routed, ids.artist, 'the pass routed it to them');
    assert.strictEqual((await versions(id)).length, 0, 'nothing submitted yet');

    /* Accept and Start first, because that is what an artist actually does and because it
       is the half that makes the round worth counting. It does NOT move the asset: the
       route only evaluates 'accept' from Assigned and opens a session without a
       transition from anywhere else, which is the same way rework after a lead's notes
       has always been started. */
    const started = await as('artist', `/assets/${id}/start`, { method: 'POST' });
    assert.strictEqual(started.status, 200, JSON.stringify(started.body));
    assert.strictEqual((await assetRow(id)).status, 'game_feedback',
      'starting work on a game bug does not move it — there is no accept step here');
    const open = await sessions(id);
    assert.strictEqual(open.length, 1, 'a session is running');
    assert.strictEqual(open[0].user_id, ids.artist);

    const sent = await as('artist', `/assets/${id}/submit`, {
      method: 'POST', body: { link: 'https://example.com/fix-1', description: 'moved the collider' } });
    assert.strictEqual(sent.status, 201, JSON.stringify(sent.body));

    const after = await assetRow(id);
    assert.strictEqual(after.status, 'pending_tl_review',
      'the fix goes back to the gate that answered the bug');
    assert.strictEqual(after.routed, null, 'into the queue, like every other submission');

    /* THE ROUND, and this is the claim the whole design rests on: nothing created one.
       The version row IS the round, so the Efficiency report counts it with no change to
       the report and no round-creation logic anywhere. */
    const v = await versions(id);
    assert.strictEqual(v.length, 1, 'one submission');
    assert.strictEqual(Number(v[0].version_number), 1);
    assert.strictEqual(v[0].stage, 'tl', 'aimed at the gate it is going to');
    assert.strictEqual(v[0].link, 'https://example.com/fix-1');
    assert.strictEqual(v[0].uploaded_by, ids.artist);

    // And the clock was stopped against it, the same way a submission always stops one.
    const closed = await sessions(id);
    assert.strictEqual(closed.length, 1);
    assert.strictEqual(closed[0].ended_reason, 'submitted');
    assert.strictEqual(Number(closed[0].round), 1, 'the round the stretch belongs to');

    const log = await events(id);
    const last = log[log.length - 1];
    assert.strictEqual(last.action, 'submit');
    assert.strictEqual(last.from_status, 'game_feedback');
    assert.strictEqual(last.to_status, 'pending_tl_review');
  });

  await t.test('and the lead can then review it as an ordinary submission', async () => {
    /* The fix is worth nothing if the round it produced is not a round the pipeline can
       finish. One more step proves it: the gate accepts it. */
    const id = await passedToArtist('Reviewable');
    await as('artist', `/assets/${id}/start`, { method: 'POST' });
    assert.strictEqual((await as('artist', `/assets/${id}/submit`,
      { method: 'POST', body: { link: 'https://example.com/fix-2' } })).status, 201);
    const reviewed = await as('lead', `/assets/${id}/review`, {
      method: 'POST', body: { decision: 'approved', text: 'fixed' } });
    assert.strictEqual(reviewed.status, 200, JSON.stringify(reviewed.body));
    assert.strictEqual((await assetRow(id)).status, 'tl_approved',
      'through the first gate and onward, with nothing special about its origin');
  });

  await t.test('a second round on the same bug adds to the first, it does not replace it', async () => {
    const id = await passedToArtist('Twice');
    await as('artist', `/assets/${id}/start`, { method: 'POST' });
    await as('artist', `/assets/${id}/submit`, { method: 'POST', body: { link: 'https://example.com/a' } });
    // Sent back, worked again, handed in again — the ordinary rework loop.
    assert.strictEqual((await as('lead', `/assets/${id}/review`,
      { method: 'POST', body: { decision: 'changes_requested', text: 'still clips' } })).status, 200);
    assert.strictEqual((await assetRow(id)).status, 'tl_changes_requested');
    await as('artist', `/assets/${id}/start`, { method: 'POST' });
    assert.strictEqual((await as('artist', `/assets/${id}/submit`,
      { method: 'POST', body: { link: 'https://example.com/b' } })).status, 201);

    const v = await versions(id);
    assert.deepStrictEqual(v.map((x) => Number(x.version_number)), [1, 2],
      'two rounds, kept — the submission table is append-only');
    const rounds = [...new Set((await sessions(id)).map((x) => Number(x.round)))];
    assert.deepStrictEqual(rounds, [1, 2], 'and the clock recorded a stretch against each');
  });

  await t.test('an artist cannot answer a bug still sitting in the queue', async () => {
    /* The guard that makes the transition safe to offer. Raised and NOT passed: the asset
       is routed to nobody, the lead has not decided, and game_feedback is not in
       ASSIGNEE_STATUSES — so the assignee is not its holder and submitting over the top of
       the decision is refused. */
    const id = await delivered('Unanswered');
    await raise(id);
    const row = await assetRow(id);
    assert.strictEqual(row.status, 'game_feedback');
    assert.strictEqual(row.routed, null, 'in the queue, with nobody on it');

    const refused = await as('artist', `/assets/${id}/submit`,
      { method: 'POST', body: { link: 'https://example.com/too-soon' } });
    assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
    assert.strictEqual((await versions(id)).length, 0, 'and no round was recorded');
  });

  await t.test('the artist cannot start on a bug the lead has not passed on', async () => {
    /* The guard beside the new STARTABLE entry. Raised and not answered: the asset is in
       the queue, and an artist opening a session on it would be taking the decision out of
       the lead's hands — the same rule CD Feedbacks has while the notes are unrelayed. */
    const id = await delivered('Not Passed Yet');
    await raise(id);
    const refused = await as('artist', `/assets/${id}/start`, { method: 'POST' });
    assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
    assert.match(refused.body.error, /has not passed this game bug on/);
    assert.strictEqual((await sessions(id)).length, 0, 'and no stretch was opened');

    // Passed on, and the same click works.
    assert.strictEqual((await as('lead', `/assets/${id}/game-feedback`,
      { method: 'POST', body: { decision: 'pass' } })).status, 200);
    assert.strictEqual((await as('artist', `/assets/${id}/start`, { method: 'POST' })).status, 200);
    assert.strictEqual((await sessions(id)).length, 1, 'now the clock runs');
    assert.strictEqual((await assetRow(id)).status, 'game_feedback',
      'and starting still moves nothing — there is no accept step at this stage');
  });

  /* --- 2: the lead hands the round on ------------------------------------- */

  await t.test('the lead who passed a bug on can hand the round to another lead', async () => {
    const id = await passedToArtist('Handed On');

    const handed = await as('lead', `/assets/${id}/reassign`, {
      method: 'POST', body: { assigneeId: ids.second, note: 'artist is on leave' } });
    assert.strictEqual(handed.status, 200, JSON.stringify(handed.body));

    const after = await assetRow(id);
    assert.strictEqual(after.status, 'assigned',
      'landing in Assigned, so the incoming person starts their own round from nothing');
    assert.strictEqual(after.assignee, ids.second);
    assert.strictEqual(after.routed, ids.second);

    const log = await events(id);
    assert.strictEqual(log[log.length - 1].action, 'reassign_review');
    assert.strictEqual(log[log.length - 1].from_status, 'game_feedback');
  });

  await t.test('and so can another lead holding the same gate, but not a lead off the project', async () => {
    /* The gate is canActAtTlGate, so it is the project's review team and not the person
       who happened to press Pass. A second lead on the team may reroute the round; a lead
       with the same designation and no standing on this project may not — which is the
       case a permission-only check would have waved through. */
    const id = await passedToArtist('Other Lead');
    const byOther = await as('otherLead', `/assets/${id}/reassign`, {
      method: 'POST', body: { assigneeId: ids.second } });
    assert.strictEqual(byOther.status, 200, JSON.stringify(byOther.body));
    assert.strictEqual((await assetRow(id)).assignee, ids.second);

    /* The stranger is refused, and by the FIRST of the route's two 403s rather than by
       the switch this fix changed — their designation is scoped to their own team, so they
       have no reach on this project at all and never get as far as the stage. Asserted on
       the message, because "403" alone would have let the switch be widened to `return
       true` without this noticing: the two refusals mean different things and this is the
       one that applies. */
    const second = await passedToArtist('Stranger Lead');
    const byStranger = await as('stranger', `/assets/${second}/reassign`, {
      method: 'POST', body: { assigneeId: ids.second } });
    assert.strictEqual(byStranger.status, 403, JSON.stringify(byStranger.body));
    assert.match(byStranger.body.error, /do not have permission to hand this asset/,
      'refused for having no business with this project, not for the stage it is in');
    assert.strictEqual((await assetRow(second)).assignee, ids.artist, 'and nothing moved');
  });

  await t.test('the artist holding the bug cannot hand it on to somebody else', async () => {
    /* Handing work on is a decision about who does it, which is the lead's. The artist
       has the round, and their move is to submit it. */
    const id = await passedToArtist('Not Theirs To Pass');
    const refused = await as('artist', `/assets/${id}/reassign`, {
      method: 'POST', body: { assigneeId: ids.second } });
    assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
    assert.match(refused.body.error, /do not have permission to hand this asset/,
      'an artist has no assigning reach at all — they are not refused for the stage');
    assert.strictEqual((await assetRow(id)).assignee, ids.artist);
  });

  await t.test('a bug still in the queue can be handed on too, by the gate', async () => {
    /* Not routed to anybody yet. The gate is about standing on the asset rather than about
       holding it, so a lead may put somebody on the work before answering the bug —
       which is the "artist is on leave" case arriving before anyone has pressed Pass. */
    const id = await delivered('Queued And Handed');
    await raise(id);
    assert.strictEqual((await assetRow(id)).routed, null);
    const handed = await as('lead', `/assets/${id}/reassign`, {
      method: 'POST', body: { assigneeId: ids.second } });
    assert.strictEqual(handed.status, 200, JSON.stringify(handed.body));
    assert.strictEqual((await assetRow(id)).status, 'assigned');
  });

  /* --- 3: what the page offers is what the server honours ----------------- */

  await t.test('every rework stage the page shortcuts is one the server accepts', async () => {
    /* GAP 3 END TO END. The page offers "Reassign to Same User" on each of its
       REWORK_STATUSES; this drives the endpoint behind it on each of them, as the lead,
       and asserts none answers 403. Before the gate was fixed, game_feedback did. */
    const reach = {
      tl_changes_requested: async () => {
        const id = await delivered('Rework TL');
        await sql(cfg, 'UPDATE assets SET `status` = ?, routed_to_id = ? WHERE id = ?',
          ['tl_changes_requested', ids.artist, id]);
        return id;
      },
      cd_changes_requested: async () => {
        const id = await delivered('Rework CD');
        await sql(cfg, 'UPDATE assets SET `status` = ?, routed_to_id = ? WHERE id = ?',
          ['cd_changes_requested', ids.lead, id]);
        return id;
      },
      game_feedback: () => passedToArtist('Rework Game'),
    };
    for (const status of REWORK_STATUSES) {
      const make = reach[status];
      assert.ok(make, `this test has no way to reach ${status} — add one rather than skipping it`);
      const id = await make();
      assert.strictEqual((await assetRow(id)).status, status);
      const handed = await as('lead', `/assets/${id}/reassign`, {
        method: 'POST', body: { assigneeId: ids.artist } });
      assert.strictEqual(handed.status, 200,
        `the page offers the shortcut in ${status} and the server answered `
        + `${handed.status}: ${JSON.stringify(handed.body)}`);
    }
  });
});
