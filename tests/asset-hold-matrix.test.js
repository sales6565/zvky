/* THE HOLD MATRIX: who may put which task down, and what they are told when they may not.
 *
 * THE THIRD REPORT OF THIS BUTTON is what this file is. The first two each checked a
 * narrow case and found the gates agreeing — which they were. What neither tried was a
 * TABLE: every designation against every state of a task, with the server's answer and the
 * page's control recorded side by side. Run against the shipped code, that table had five
 * failing kinds of cell, and every one of them is a row below.
 *
 *   senior_team_lead / technical_manager   in the Supervision group, not in the four-key
 *                                          list Prompt 20 wrote, so refused on a project
 *                                          they supervise while a Team Lead on the same
 *                                          project was allowed.
 *   an outsourced task                     refused with "Only the person a task is assigned
 *                                          to can put it on hold" — a task assigned to
 *                                          nobody, because its holder is a freelancer with
 *                                          no login. And hold had no freelancer check at
 *                                          all, while resume did.
 *   every other refusal                    reached the person as a missing button.
 *   a lead's resume                        opened the session under the LEAD, crediting an
 *                                          artist's hours to whoever pressed it.
 *   the timesheet gate                     refused a lead's resume over the lead's own
 *                                          paperwork.
 *
 * HOW THE TABLE IS DRIVEN. src/asset-hold.js is pure — every fact it needs is passed in —
 * so the whole matrix runs with no server and no database, which is what makes it a table
 * rather than a morning. The live section below then proves the wiring: that the routes and
 * the board's per-asset flag really do reach that function, and that the parts it does not
 * decide (whose clock reopens, the one-active-task rule) behave as the fix intends.
 *
 * FIXED DATES AND openStudio, so no cell depends on the hour the suite runs at: the shipped
 * lunch blackout would otherwise put a fixture's session down and every assertion would fail
 * for the wrong reason.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const assetHold = require('../src/asset-hold');
const perms = require('../src/permissions');
const { ROLES } = require('../src/reference-defaults');
const { config, resetSchema, startServer, stopServer, api, sql, openStudio,
  SKIP_REASON } = require('./helpers');

const cfg = config('holdmatrix');
const PASSWORD = 'HoldMatrix-1!';
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const SRC = (f) => fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8');

const C = assetHold.CODES;
const defOf = (key) => ROLES.find((r) => r.key === key) || null;

// ---------------------------------------------------------------------------
// WHO. The real designation keys, including the two Prompt 20 left out and the
// coordinator, whose membership table the scope deliberately does not read.
// ---------------------------------------------------------------------------
const WHO = {
  artist: { id: 'u-ana', role: 'game_artist' },
  animator: { id: 'u-ani', role: 'game_animator' },
  lead: { id: 'u-tl', role: 'team_lead' },
  assocLead: { id: 'u-atl', role: 'associate_team_lead' },
  artSup: { id: 'u-as', role: 'art_supervisor' },
  animSup: { id: 'u-ams', role: 'associate_animation_supervisor' },
  seniorLead: { id: 'u-stl', role: 'senior_team_lead' },
  techMgr: { id: 'u-tm', role: 'technical_manager' },
  coordinator: { id: 'u-co', role: 'coordinator' },
  artDirector: { id: 'u-ad', role: 'art_director' },
  root: { id: 'u-root', role: 'super_admin' },
  stranger: { id: 'u-x', role: 'game_artist' },
};
// Everyone in the Supervision group, by the catalogue rather than by this list.
const SUPERVISION = Object.keys(WHO).filter((k) => (defOf(WHO[k].role) || {}).group === 'Supervision');

// ---------------------------------------------------------------------------
// WHAT. One task, in each state the matrix needs.
// ---------------------------------------------------------------------------
const ASSET = { id: 'a1', project_id: 'p1', code: 'CHR-001', assignee_id: WHO.artist.id };
const STATES = {
  running: { openSession: true, held: null },
  paused: { openSession: false, held: { byStudio: true, since: 'x' } },
  heldByHand: { openSession: false, held: { byStudio: false, since: 'x' } },
  neverStarted: { openSession: false, held: null },
};

const facts = (who, state, extra = {}) => ({
  user: WHO[who],
  asset: ASSET,
  holdsPermission: true,
  roleDef: defOf(WHO[who].role),
  leadsProject: false,
  ...STATES[state],
  ...extra,
});

// ===========================================================================
// 1. THE TABLE. Every cell is one call to the one function.
// ===========================================================================

test('the matrix: who may hold, and the reason when they may not', () => {
  /* [who, state, leads this project, expected hold code, expected resume code]
     null as a code means allowed. The codes are the point: a cell that refuses
     for the WRONG reason is as much a bug as one that refuses wrongly, because
     the reason is what the person reads. */
  const rows = [
    // --- the assignee, which is the behaviour that must not change ----------
    ['artist', 'running', false, null, C.ALREADY_RUNNING],
    ['artist', 'heldByHand', false, C.ALREADY_HELD, null],
    ['artist', 'neverStarted', false, C.NO_SESSION, C.NOT_HELD],
    ['artist', 'paused', false, C.ALREADY_HELD, C.STUDIO_PAUSED],

    // --- a lead ON the project: allowed, whoever is working on it -----------
    ['lead', 'running', true, null, C.ALREADY_RUNNING],
    ['lead', 'heldByHand', true, C.ALREADY_HELD, null],
    ['lead', 'neverStarted', true, C.NO_SESSION, C.NOT_HELD],
    ['lead', 'paused', true, C.ALREADY_HELD, C.STUDIO_PAUSED],

    // --- a lead NOT on the project: no extra rights at all ------------------
    ['lead', 'running', false, C.NOT_YOURS, C.NOT_YOURS],
    ['lead', 'heldByHand', false, C.NOT_YOURS, C.NOT_YOURS],
    /* AND THE REASON IS THE SCOPE ONE even where the state would also refuse:
       "this is not yours" outranks "there is nothing running", because the
       second would tell somebody to go and start work they may not touch. */
    ['lead', 'neverStarted', false, C.NOT_YOURS, C.NOT_YOURS],

    // --- the rest of the Supervision group, on their own project ------------
    ['assocLead', 'running', true, null, C.ALREADY_RUNNING],
    ['artSup', 'running', true, null, C.ALREADY_RUNNING],
    ['animSup', 'running', true, null, C.ALREADY_RUNNING],
    /* THE TWO PROMPT 20 LEFT OUT. Measured at HOLD_NOT_YOURS before this
       change, on a project they supervise. */
    ['seniorLead', 'running', true, null, C.ALREADY_RUNNING],
    ['techMgr', 'running', true, null, C.ALREADY_RUNNING],
    ['seniorLead', 'heldByHand', true, C.ALREADY_HELD, null],
    ['techMgr', 'heldByHand', true, C.ALREADY_HELD, null],

    // --- and nobody else, however senior ------------------------------------
    ['coordinator', 'running', true, C.NOT_YOURS, C.NOT_YOURS],
    ['artDirector', 'running', true, C.NOT_YOURS, C.NOT_YOURS],
    ['root', 'running', true, C.NOT_YOURS, C.NOT_YOURS],
    ['animator', 'running', false, C.NOT_YOURS, C.NOT_YOURS],
    ['stranger', 'running', false, C.NOT_YOURS, C.NOT_YOURS],
  ];

  for (const [who, state, leads, holdCode, resumeCode] of rows) {
    const f = facts(who, state, { leadsProject: leads });
    const h = assetHold.decide('hold', f);
    const r = assetHold.decide('resume', f);
    const label = `${who} / ${state} / ${leads ? 'leads it' : 'does not lead it'}`;
    assert.strictEqual(h.code, holdCode, `HOLD ${label}: ${h.message || 'allowed'}`);
    assert.strictEqual(h.ok, holdCode === null, `HOLD ${label} ok flag`);
    assert.strictEqual(r.code, resumeCode, `RESUME ${label}: ${r.message || 'allowed'}`);
    assert.strictEqual(r.ok, resumeCode === null, `RESUME ${label} ok flag`);
    // Every refusal has a sentence, and every sentence is a sentence.
    if (!h.ok) assert.match(h.message, /\w+.*\.$/, `HOLD ${label} explains itself`);
    if (!r.ok) assert.match(r.message, /\w+.*\.$/, `RESUME ${label} explains itself`);
  }
});

test('the whole Supervision group is allowed, and nothing outside it is', () => {
  /* DERIVED FROM THE CATALOGUE rather than from the row list above, so a
     designation a Super Admin adds to Supervision is covered without this test
     being edited — and one added anywhere else is not. */
  for (const who of SUPERVISION) {
    assert.strictEqual(
      assetHold.decide('hold', facts(who, 'running', { leadsProject: true })).ok, true,
      `${WHO[who].role} is in Supervision and leads this project`);
  }
  assert.ok(SUPERVISION.includes('seniorLead') && SUPERVISION.includes('techMgr'),
    'including the two Prompt 20 left out');
  /* `artist` is left out of this loop on purpose: they are the assignee in this
     fixture, so they are allowed for the other reason, and including them would
     be testing the wrong thing. `stranger` holds the same designation. */
  for (const who of ['animator', 'coordinator', 'artDirector', 'root', 'stranger']) {
    assert.strictEqual(
      assetHold.decide('hold', facts(who, 'running', { leadsProject: true })).code, C.NOT_YOURS,
      `${WHO[who].role} is not in Supervision, so leading the project is not enough`);
  }
});

test('an outsourced task refuses with the freelancer, on BOTH verbs', () => {
  /* THE WORST OF THE OLD MESSAGES. An outsourced task has no internal assignee,
     so the assignee test caught it and said "Only the person a task is assigned
     to can put it on hold or resume it" — about a task assigned to nobody. The
     freelancer check is now FIRST among the reasons about the task, which is
     what makes the sentence true.
     
     AND HOLD HAD NO SUCH CHECK AT ALL while resume did: measured at
     409 "Start the work before putting it on hold" on an outsourced task. */
  const outsourced = { freelancerName: 'Fran Freelance' };
  for (const who of ['artist', 'lead', 'seniorLead', 'root']) {
    for (const verb of ['hold', 'resume']) {
      const v = assetHold.decide(verb, facts(who, 'running', {
        leadsProject: true, outsourcedTo: outsourced, asset: { ...ASSET, assignee_id: null },
      }));
      assert.strictEqual(v.code, C.OUTSOURCED, `${verb} as ${who}`);
      assert.match(v.message, /out with Fran Freelance/);
      assert.match(v.message, /no timer here/);
      assert.ok(v.offer, 'and it is worth a disabled control with the reason');
    }
  }

  /* IT OUTRANKS THE ASSIGNEE TEST EVEN WHEN THERE IS ONE — the drifted shape,
     which only legacy data has: outsourced and still holding an internal
     assignee. The app refuses to create it (outsourceBlocked clears the
     assignee first, and normalise() deletes the sessions), which is why it is
     tested here rather than built. */
  const drifted = assetHold.decide('hold', facts('artist', 'running', {
    outsourcedTo: outsourced,
  }));
  assert.strictEqual(drifted.code, C.OUTSOURCED,
    'even to the assignee, whose own task it still says it is');
});

test('an unassigned task has no clock to hold, and says so', () => {
  const v = assetHold.decide('hold', facts('lead', 'running', {
    leadsProject: true, asset: { ...ASSET, assignee_id: null },
  }));
  assert.strictEqual(v.code, C.UNASSIGNED);
  assert.match(v.message, /Nobody in the studio is on this task/);
  assert.strictEqual(v.offer, false, 'and is not worth a disabled button');
});

test('the studio\'s switch comes first, and is not worth a disabled button either', () => {
  const v = assetHold.decide('hold', facts('artist', 'running', { holdsPermission: false }));
  assert.strictEqual(v.code, C.NO_PERMISSION);
  assert.match(v.message, /Settings/, 'and says where it is switched on');
  assert.strictEqual(v.offer, false);
  /* BEFORE EVERYTHING, including the freelancer: somebody whose designation
     cannot hold anything does not need telling about this task in particular. */
  const both = assetHold.decide('hold', facts('artist', 'running', {
    holdsPermission: false, outsourcedTo: { freelancerName: 'Fran' },
  }));
  assert.strictEqual(both.code, C.NO_PERMISSION);
});

test('which refusals are drawn as a disabled control, and which are not', () => {
  /* THE PAGE DOES NOT DECIDE THIS. A disabled button with the reason is better
     wherever somebody would otherwise wonder — they started this task this
     morning and the button has gone — and worse where the task is simply none
     of their business, which is most cards on most boards. Deciding it on the
     page would be another copy of a rule. */
  const shown = Object.entries(assetHold.OFFER).filter(([, v]) => v).map(([k]) => k).sort();
  const hidden = Object.entries(assetHold.OFFER).filter(([, v]) => !v).map(([k]) => k).sort();
  assert.deepStrictEqual(hidden,
    [C.NO_PERMISSION, C.NOT_YOURS, C.UNASSIGNED].sort(),
    'the three that mean "this is not your business"');
  assert.deepStrictEqual(shown,
    [C.ALREADY_HELD, C.ALREADY_RUNNING, C.NOT_HELD, C.NO_SESSION, C.OUTSOURCED,
      C.STUDIO_PAUSED].sort(),
    'and every state refusal is explained in place');
  // Every code in the module has an answer, so a new one cannot default silently.
  for (const code of Object.values(C)) {
    assert.ok(code in assetHold.OFFER, `${code} says whether it is drawn`);
  }
});

// ===========================================================================
// 2. ONE RULE, AND NO SECOND COPY. The consistency the brief asks for, which
//    after this change is "the page has no rule" rather than "the two agree".
// ===========================================================================

test('the routes, the payload and the page all read one answer', () => {
  const route = SRC('routes/assets.js');
  assert.match(route, /assetHold\.decide\(action, facts\)/);
  assert.match(route, /assetHold\.state\(await holdFactsFor\(viewer, a, \{/);
  assert.ok(!/HOLD_OTHERS_ROLES/.test(route), 'the hardcoded designation list is gone');
  assert.ok(!/mayHoldOthers/.test(route), 'and the second copy that used it');

  /* THE PAGE HAS NO CONJUNCTION OF ITS OWN any more. It had three terms — the
     flag, work_open, and held.byStudio — each of which the server also knew. */
  assert.match(PAGE, /const canHold = hs \? hs\.canHold : fallbackHold;/);
  assert.match(PAGE, /const canResume = hs \? hs\.canResume : fallbackResume;/);
  assert.match(PAGE, /const holdWhy = hs && !hs\.canHold && hs\.hold\.offer \? hs\.hold\.message : null;/);
  /* Counted over CODE, not over the file: the note above the new lines quotes the
     old conjunction, and a comment is not a rule. */
  const pageCode = PAGE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
  assert.ok(!/can_hold_others/.test(pageCode),
    'the old flag is no longer a term in a page-side rule');
});

test('neither side has a list of eligible statuses, so there is none to diverge', () => {
  /* MEASURED, NOT ASSUMED: a lead was offered and granted a hold on an open
     session in every one of the nine statuses an asset can be in, delivered
     included. There is no status condition on either side.
     
     AND THAT IS RIGHT, because the condition that matters is already exact —
     hold needs an OPEN STRETCH, and a stretch is only ever opened from a status
     where work runs. A list here would be a second, weaker statement of a
     condition already enforced, and the one case where the two could differ is
     a session opened legitimately whose asset has since moved, where refusing
     would strand a running clock nobody could stop.
     
     This test is the brief's "hold the two lists equal" in the form the code
     actually takes: equal by both being absent. A future list has to be added
     to both sides or to neither. */
  assert.strictEqual(assetHold.STATUS_GATE, null);
  const module = SRC('asset-hold.js');
  const body = module.slice(module.indexOf('function decide('));
  assert.ok(!/asset\.status/.test(body), 'the shared rule never reads a status');
  const route = SRC('routes/assets.js');
  const holdRoute = route.slice(route.indexOf("router.post('/:id/hold'"));
  assert.ok(!/asset\.status/.test(holdRoute.slice(0, holdRoute.indexOf('\n});'))),
    'and neither does the hold route');
  const at = PAGE.indexOf('const hs = a.hold_state || null;');
  assert.ok(!/a\.status/.test(PAGE.slice(at, at + 900)), 'and neither does the page');
});

test('the shared rule asks nothing of the database', () => {
  /* WHAT MAKES THE TABLE ABOVE A TABLE. If this module ever reaches for a
     connection, the matrix becomes an integration suite and stops being run. */
  const module = SRC('asset-hold.js');
  for (const leak of ["require('./db')", 'db.query', 'await ']) {
    assert.ok(!module.includes(leak), `src/asset-hold.js must not contain ${leak}`);
  }
});

test('the cheap refusals are answered without a query', () => {
  /* DEFENCE IN DEPTH, pinned by pointing this process at a database that does
     not exist: a refusal that could be decided from the role and the row has to
     come back without asking which projects anybody leads. The first version of
     holdFactsFor asked unconditionally and turned every one of these into a
     connection error. */
  const cases = [
    ['no permission', { id: 'u1', role: 'team_lead', permissions: [] }, { assignee_id: 'x', project_id: 'p1' }],
    ['your own task', { id: 'u1', role: 'team_lead', permissions: ['asset.hold'] }, { assignee_id: 'u1', project_id: 'p1' }],
    ['unassigned', { id: 'u1', role: 'team_lead', permissions: ['asset.hold'] }, { assignee_id: null, project_id: 'p1' }],
    ['outside Supervision', { id: 'u1', role: 'game_artist', permissions: ['asset.hold'] }, { assignee_id: 'x', project_id: 'p1' }],
  ];
  return Promise.all(cases.map(([label, user, asset]) =>
    perms.holdFactsFor(user, asset, { openSession: true }).then((f) => {
      assert.strictEqual(f.leadsProject, false, `${label}: answered without the query`);
    }, (err) => {
      assert.fail(`${label} reached the database: ${err && err.message}`);
    })));
});

// ===========================================================================
// 3. THE PAGE, against a DOM stub: the control, and its reason.
// ===========================================================================

function panelFor(assetRow, viewerId, held = ['asset.hold']) {
  /* The page's own lines, lifted — the four that turn hold_state into two
     controls, and the markup that draws them. Nothing is re-implemented: the
     point of the change is that the browser has no rule to re-implement. */
  const from = PAGE.indexOf('const hs = a.hold_state || null;');
  assert.ok(from !== -1, 'the page still reads hold_state');
  const to = PAGE.indexOf('const resumeWhy =', from);
  const decide = PAGE.slice(from, PAGE.indexOf(';', to) + 1);

  const markupFrom = PAGE.indexOf('${canHold ? `<button class="btn btn-ghost" id="d_holdBtn"');
  assert.ok(markupFrom !== -1, 'and still draws the two buttons from it');
  /* Cut at the end of the Resume expression rather than a character count: the
     next thing in the panel is the held badge, and taking any of it would make
     this a test of the wrong markup. */
  const tail = "Resume</button>` : '')}";
  const markupTo = PAGE.indexOf(tail, markupFrom);
  assert.ok(markupTo !== -1, 'the two controls end where this test expects');
  const markup = PAGE.slice(markupFrom, markupTo + tail.length);

  /* `held` is the panel's own earlier line (`const held = a.held || null`), which the
     fallback and the held badge both read. Supplied rather than included in the slice,
     because the lines in between are about three other controls. */
  // eslint-disable-next-line no-new-func
  const html = new Function('a', 'mine', 'can', 'escapeHTML', 'held', `
    ${decide}
    return \`${markup}\`;`)(
    assetRow,
    assetRow.assignee_id === viewerId,
    (...keys) => keys.some((k) => held.includes(k)),
    (s) => String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
    assetRow.held || null,
  );

  const one = (id) => {
    const at = html.indexOf(`id="${id}"`);
    if (at === -1) return { drawn: false, disabled: false, title: null };
    const tagStart = html.lastIndexOf('<button', at);
    const tag = html.slice(tagStart, html.indexOf('>', at) + 1);
    const title = (tag.match(/title="([^"]*)"/) || [])[1] || null;
    return { drawn: true, disabled: /\bdisabled\b/.test(tag), title };
  };
  return { hold: one('d_holdBtn'), resume: one('d_resumeBtn'), html };
}

const rowFor = (overrides = {}) => ({
  id: 'a1', project_id: 'p1', code: 'CHR-001', assignee_id: WHO.artist.id,
  work_open: true, held: null,
  hold_state: assetHold.state(facts('artist', 'running')),
  ...overrides,
});

test('the page draws the control, or a disabled one carrying the reason', () => {
  const ok = panelFor(rowFor(), WHO.artist.id);
  // Allowed: a live button, and the tooltip says what pressing it does.
  assert.ok(ok.hold.drawn && !ok.hold.disabled, 'Hold is live for the assignee');
  assert.match(ok.hold.title, /Stop the clock/);

  /* AND RESUME IS DRAWN BESIDE IT, DISABLED, saying why — which is a change in
     behaviour rather than a detail of this test. The old page omitted it: a task
     under way simply had no Resume control, and somebody looking for the one
     they used this morning found nothing and no explanation. ALREADY_RUNNING is
     an offered refusal precisely because "it is already running" is the thing
     they need told. */
  assert.ok(ok.resume.drawn, 'Resume is drawn');
  assert.ok(ok.resume.disabled, 'and disabled');
  assert.match(ok.resume.title, /already under way/i, 'and says why');
});

test('every offered refusal reaches the page as a disabled button with its sentence', () => {
  const cases = [
    ['nothing running', 'neverStarted', 'hold', /no running session to hold/i],
    ['already held', 'heldByHand', 'hold', /already on hold/i],
    ['not held', 'neverStarted', 'resume', /not on hold/i],
    ['already running', 'running', 'resume', /already under way/i],
    ['the schedule paused it', 'paused', 'resume', /starts it again by itself/i],
  ];
  for (const [label, state, verb, wording] of cases) {
    const hold_state = assetHold.state(facts('artist', state));
    const row = rowFor({ hold_state, work_open: STATES[state].openSession, held: STATES[state].held });
    const drawn = panelFor(row, WHO.artist.id)[verb];
    assert.ok(drawn.drawn, `${label}: the ${verb} control is drawn`);
    assert.ok(drawn.disabled, `${label}: and disabled`);
    assert.match(drawn.title, wording, `${label}: and carries the reason`);
  }
});

test('a task that is none of your business draws nothing at all', () => {
  for (const code of ['NOT_YOURS', 'UNASSIGNED', 'NO_PERMISSION']) {
    const f = code === 'NOT_YOURS' ? facts('stranger', 'running')
      : code === 'UNASSIGNED' ? facts('lead', 'running', { leadsProject: true, asset: { ...ASSET, assignee_id: null } })
        : facts('artist', 'running', { holdsPermission: false });
    const row = rowFor({ hold_state: assetHold.state(f), assignee_id: 'somebody-else' });
    const panel = panelFor(row, WHO.stranger.id, code === 'NO_PERMISSION' ? [] : ['asset.hold']);
    assert.strictEqual(panel.hold.drawn, false, `${code}: no Hold button`);
    assert.strictEqual(panel.resume.drawn, false, `${code}: no Resume button`);
  }
});

test('a lead sees the control on a task that is not theirs, and is told what it does', () => {
  /* THE REPORTED SCENARIO, on the page: an assigned Team Lead opening a normal
     artist's In Progress asset. The tooltip differs from the assignee's, because
     the two are doing different things. */
  const row = rowFor({ hold_state: assetHold.state(facts('lead', 'running', { leadsProject: true })) });
  const panel = panelFor(row, WHO.lead.id);
  assert.ok(panel.hold.drawn && !panel.hold.disabled);
  assert.match(panel.hold.title, /you lead or supervise its project/);
});

test('an undecorated row falls back to mine-only, not to a silent absence', () => {
  /* An asset that reached the panel by some route that did not decorate it. The
     old behaviour, with the server as the authority — rather than a control that
     vanishes because a key is missing. */
  const mine = panelFor(rowFor({ hold_state: undefined }), WHO.artist.id);
  assert.ok(mine.hold.drawn && !mine.hold.disabled, 'the assignee keeps their button');
  const theirs = panelFor(rowFor({ hold_state: undefined }), WHO.lead.id);
  assert.strictEqual(theirs.hold.drawn, false, 'and nobody else gains one');
});

test('a disabled control is an explanation, and is never wired to a request', () => {
  const at = PAGE.indexOf('const holdAction = (button, path, ask) => {');
  assert.ok(at !== -1);
  assert.match(PAGE.slice(at, at + 700), /if\(button\.disabled\) return;/);
});

// ===========================================================================
// 4. AGAINST A LIVE SERVER: the wiring, and the two things the rule does not
//    decide — whose clock reopens, and whose one-task slot is checked.
// ===========================================================================

test('hold and resume, end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const tok = {};
  const id = {};
  const as = (who, p, o = {}) => api(server.base, p, { ...o, token: tok[who] });
  const login = async (email) => (await api(server.base, '/auth/login',
    { method: 'POST', body: { email, password: PASSWORD } })).body.token;

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'hm-boot', WORK_HOURS_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'hm-boot', name: 'Root', email: 'root@hm.test', password: PASSWORD } });
    tok.root = await login('root@hm.test');
    /* Hold reads the held state from the SCHEDULE. Without this the shipped lunch
       blackout puts a fixture's session down and every assertion fails for the
       wrong reason. */
    await openStudio(server.base, tok.root);

    const mk = async (who, role) => {
      const r = await as('root', '/users', { method: 'POST',
        body: { name: who, email: `${who}@hm.test`, role, password: PASSWORD } });
      assert.strictEqual(r.status, 201, `${role}: ${JSON.stringify(r.body)}`);
      tok[who] = await login(`${who}@hm.test`);
      return r.body.user.id;
    };
    id.ana = await mk('ana', 'game_artist');
    id.ben = await mk('ben', 'game_artist');
    id.lead = await mk('lead', 'team_lead');
    id.seniorLead = await mk('seniorLead', 'senior_team_lead');
    id.otherLead = await mk('otherLead', 'team_lead');

    const clients = await as('root', '/clients');
    const a = await as('root', '/projects', { method: 'POST',
      body: { name: 'Project A', clientId: clients.body.clients[0].id,
        teamLeadIds: [id.lead], supervisionIds: [id.seniorLead] } });
    assert.strictEqual(a.status, 201, JSON.stringify(a.body));
    id.A = a.body.project.id;
    const b = await as('root', '/projects', { method: 'POST',
      body: { name: 'Project B', clientId: clients.body.clients[0].id, teamLeadIds: [id.otherLead] } });
    id.B = b.body.project.id;
  });
  t.after(async () => { if (server) await stopServer(server); });

  const settle = (who) => sql(cfg,
    'UPDATE work_sessions SET ended_at = COALESCE(ended_at, NOW()), seconds = COALESCE(seconds, 0), '
    + "ended_reason = 'submitted' WHERE user_id = ? AND (ended_at IS NULL OR ended_reason = 'held')",
    [id[who]]);

  const running = async (name, who = 'ana', project = 'A') => {
    await settle(who);
    const r = await as('root', `/assets/project/${id[project]}`, { method: 'POST',
      body: { name, type: 'prop', assigneeId: id[who] } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const started = await as(who, `/assets/${r.body.asset.id}/start`, { method: 'POST' });
    assert.strictEqual(started.status, 200, JSON.stringify(started.body));
    return r.body.asset.id;
  };
  const card = async (who, assetId, project = 'A') => {
    const board = await as(who, `/assets/project/${id[project]}`);
    assert.strictEqual(board.status, 200, JSON.stringify(board.body));
    return (board.body.assets || []).find((x) => x.id === assetId);
  };

  await t.test('REGRESSION — a normal artist holds their own In Progress asset', async () => {
    /* The second of the two reported scenarios, exactly as reported. */
    const assetId = await running('Own Work');
    const row = await card('ana', assetId);
    assert.strictEqual(row.hold_state.canHold, true, 'the server says the button is live');
    assert.ok(panelFor({ ...row }, id.ana).hold.drawn, 'and the page draws it');
    const put = await as('ana', `/assets/${assetId}/hold`, { method: 'POST' });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
    assert.strictEqual(put.body.held, true);
  });

  await t.test('REGRESSION — an assigned Team Lead holds a normal artist\'s asset', async () => {
    /* The first of the two reported scenarios, exactly as reported. */
    const assetId = await running('Artist Work');
    const row = await card('lead', assetId);
    assert.strictEqual(row.hold_state.canHold, true);
    const panel = panelFor({ ...row }, id.lead);
    assert.ok(panel.hold.drawn && !panel.hold.disabled, 'the page draws a live Hold');
    const put = await as('lead', `/assets/${assetId}/hold`, { method: 'POST' });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
    const session = (await sql(cfg,
      'SELECT user_id, ended_reason FROM work_sessions WHERE asset_id = ? ORDER BY started_at DESC LIMIT 1',
      [assetId]))[0];
    assert.strictEqual(session.ended_reason, 'held', 'the clock really stopped');
    assert.strictEqual(session.user_id, id.ana,
      'and the stretch that stopped is still the artist\'s');
  });

  await t.test('REGRESSION — a Senior Team Lead on the project is no longer refused', async () => {
    const assetId = await running('For The Senior Lead');
    const row = await card('seniorLead', assetId);
    assert.strictEqual(row.hold_state.canHold, true,
      'measured at false, with a 403 behind it, before this change');
    const put = await as('seniorLead', `/assets/${assetId}/hold`, { method: 'POST' });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));
  });

  await t.test('a lead on another project is refused, with the scope reason', async () => {
    const assetId = await running('Not Their Project');
    const refused = await as('otherLead', `/assets/${assetId}/hold`, { method: 'POST' });
    assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
    assert.strictEqual(refused.body.code, C.NOT_YOURS);
    const still = (await sql(cfg,
      'SELECT ended_reason FROM work_sessions WHERE asset_id = ? ORDER BY started_at DESC LIMIT 1',
      [assetId]))[0];
    assert.strictEqual(still.ended_reason, null, 'and the clock is still running');
  });

  await t.test('THE REOPENED STRETCH BELONGS TO THE ASSIGNEE, not to whoever pressed it', async () => {
    /* MEASURED ON THE SHIPPED CODE: a lead's resume opened the session under the
       LEAD, and the round then read "who: ana, lead" — the artist's hours
       accruing against their lead, and the lead's own one-task slot consumed by
       work they were not doing. */
    const assetId = await running('Resumed By The Lead');
    assert.strictEqual((await as('lead', `/assets/${assetId}/hold`, { method: 'POST' })).status, 200);
    const back = await as('lead', `/assets/${assetId}/resume`, { method: 'POST' });
    assert.strictEqual(back.status, 200, JSON.stringify(back.body));

    const open = (await sql(cfg,
      'SELECT user_id FROM work_sessions WHERE asset_id = ? AND ended_at IS NULL', [assetId]));
    assert.strictEqual(open.length, 1, 'exactly one stretch is open');
    assert.strictEqual(open[0].user_id, id.ana, 'and it is the artist\'s');

    const row = await card('lead', assetId);
    assert.deepStrictEqual(row.rounds_spent.map((r) => r.who), ['ana'],
      'the round names one person, which is whose work it is');
    /* AND THE ACT IS STILL RECORDED AGAINST WHOEVER DID IT, which is where the
       studio reads who did what. */
    const events = await sql(cfg,
      "SELECT actor_id FROM asset_events WHERE asset_id = ? AND action = 'resume'", [assetId]);
    assert.ok(events.some((e) => e.actor_id === id.lead), 'the lead is named in the history');
  });

  await t.test('a lead cannot give an artist two open tasks at once', async () => {
    /* THE HOLE THE SAME LINE LEFT OPEN. The one-active-task rule read req.user,
       so a lead's resume was checked against the LEAD's slot and never against
       the artist's: measured, the artist ended with two open stretches. */
    const first = await running('Artist Is On This');
    const second = await running('And This Was Held', 'ben');
    // Give `second` to ana, held, while `first` runs for her.
    await as('root', `/assets/${second}/assign`, { method: 'POST', body: { assigneeId: id.ana } })
      .catch(() => null);
    await sql(cfg, 'UPDATE assets SET assignee_id = ? WHERE id = ?', [id.ana, second]);
    await sql(cfg, "UPDATE work_sessions SET user_id = ?, ended_at = NOW(), seconds = 60, "
      + "ended_reason = 'held' WHERE asset_id = ?", [id.ana, second]);
    await as('ana', `/assets/${first}/start`, { method: 'POST' });

    const refused = await as('lead', `/assets/${second}/resume`, { method: 'POST' });
    assert.strictEqual(refused.status, 409, JSON.stringify(refused.body));
    assert.match(refused.body.error, /already has/, 'and the refusal names the person');
    assert.ok(refused.body.activeWork, 'and what they have open');
    const open = await sql(cfg,
      'SELECT asset_id FROM work_sessions WHERE user_id = ? AND ended_at IS NULL', [id.ana]);
    assert.strictEqual(open.length, 1, 'the artist still has exactly one task open');
  });

  await t.test('an outsourced task refuses both verbs, naming the freelancer', async () => {
    const assetId = await running('Going Outside');
    const f = await as('root', '/outsource/freelancers', { method: 'POST',
      body: { name: 'Fran Freelance', discipline: 'art' } });
    /* The app clears the internal assignee before sending work out
       (outsourceBlocked), and normalise() then deletes the sessions — so this is
       the real shape, not a constructed one. */
    await sql(cfg, 'UPDATE assets SET assignee_id = NULL WHERE id = ?', [assetId]);
    const sent = await as('root', '/outsource/assignments', { method: 'POST',
      body: { freelancerId: f.body.freelancer.id, projectId: id.A, assetId, decidedManHours: 8 } });
    assert.strictEqual(sent.status, 201, JSON.stringify(sent.body));

    for (const who of ['ana', 'lead', 'root']) {
      for (const verb of ['hold', 'resume']) {
        const r = await as(who, `/assets/${assetId}/${verb}`, { method: 'POST' });
        assert.strictEqual(r.body.code, C.OUTSOURCED, `${who} ${verb}: ${JSON.stringify(r.body)}`);
        assert.match(r.body.error, /out with Fran Freelance/);
      }
    }
    const row = await card('lead', assetId);
    assert.strictEqual(row.hold_state.hold.code, C.OUTSOURCED,
      'and the board says the same thing, so the page can explain it');
  });

  await t.test('the permission still governs, both ways, on the same token', async () => {
    const assetId = await running('Switchable');
    const held = async () => (await as('root', '/permissions/roles/team_lead')).body.role
      .permissions.filter((p) => p.enabled).map((p) => p.key);
    const set = async (keys) => {
      const r = await as('root', '/permissions/roles/team_lead', {
        method: 'PUT', body: { permissions: keys } });
      assert.ok(r.status < 400, JSON.stringify(r.body));
    };
    const all = await held();
    await set(all.filter((k) => k !== 'asset.hold'));
    const refused = await as('lead', `/assets/${assetId}/hold`, { method: 'POST' });
    assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
    const dark = await card('lead', assetId);
    assert.strictEqual(dark.hold_state.hold.code, C.NO_PERMISSION);
    assert.strictEqual(dark.hold_state.hold.offer, false, 'and no disabled button either');

    await set(all);
    const allowed = await as('lead', `/assets/${assetId}/hold`, { method: 'POST' });
    assert.strictEqual(allowed.status, 200, JSON.stringify(allowed.body));
  });

  await t.test('THE TIMESHEET GATE IS ABOUT THE PERSON WHOSE CLOCK RUNS', async () => {
    /* MEASURED BEFORE THIS CHANGE: with requirePreviousDay on, a Team Lead
       resuming an artist's held task was refused with "Fill your timesheet for
       Friday 9 Oct to start work" — the LEAD's own paperwork stopping the
       ARTIST's work. The clock that reopens is the artist's, so the gate asks
       only when the two are the same person. */
    const assetId = await running('Owed Paperwork');
    assert.strictEqual((await as('ana', `/assets/${assetId}/hold`, { method: 'POST' })).status, 200);
    // Back-dated accounts, or everybody is exempt as a new starter.
    await sql(cfg, "UPDATE users SET created_at = '2026-01-02 04:00:00' WHERE email LIKE '%@hm.test'");
    const before = await as('root', '/admin/settings/timesheet');
    await as('root', '/admin/settings/timesheet', { method: 'PUT',
      body: { ...before.body.settings, requirePreviousDay: true } });
    try {
      // The gate is live: the artist's own resume is refused.
      const own = await as('ana', `/assets/${assetId}/resume`, { method: 'POST' });
      assert.strictEqual(own.status, 409, JSON.stringify(own.body));
      assert.match(own.body.error, /Fill your timesheet/);
      // The lead's is not, because the hours are not the lead's.
      const theirs = await as('lead', `/assets/${assetId}/resume`, { method: 'POST' });
      assert.strictEqual(theirs.status, 200, JSON.stringify(theirs.body));
    } finally {
      await as('root', '/admin/settings/timesheet', { method: 'PUT',
        body: { ...before.body.settings, requirePreviousDay: false } });
    }
  });

  await t.test('hold is subject to no clock rule, which is what makes it always available', async () => {
    /* A HOLIDAY DOES NOT BLOCK A HOLD, and must not: a studio shut for Diwali
       with a timer still running is exactly when somebody needs to stop it.
       Resume IS refused, which is the asymmetry and is deliberate. */
    const assetId = await running('Shut Today');
    const holdRoute = SRC('routes/assets.js');
    const slice = holdRoute.slice(holdRoute.indexOf("router.post('/:id/hold'"));
    const body = slice.slice(0, slice.indexOf('\n});'));
    assert.ok(!/holidayRefusal/.test(body), 'no holiday check on hold');
    assert.ok(!/timesheetRefusal/.test(body), 'no timesheet gate on hold');
    assert.ok(!/openForUser/.test(body), 'and no one-active-task rule on hold');
    // And it works, which is the behaviour those three absences buy.
    assert.strictEqual((await as('ana', `/assets/${assetId}/hold`, { method: 'POST' })).status, 200);
  });
});
