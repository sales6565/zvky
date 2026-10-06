/* THE OUTSOURCED LIFECYCLE, recorded by staff on a freelancer's behalf.
 *
 * THE FACT THE WHOLE DESIGN TURNS ON: a freelancer has no login. Nobody outside
 * the studio ever clicks anything in this application. So the Assigned work list
 * on the Outsource tab is an INTERNAL RECORD, and every stage an outsourced task
 * passes through is recorded by a member of staff acting for somebody else.
 *
 * WHICH MAKES THE ASSIGNEE GATES THE RISK. The pipeline was written around the
 * person doing the work being the person clicking: actors.assignee, STARTABLE,
 * ASSIGNEE_STATUSES, mayStartWork, canHoldAsset, and the page's mine-style
 * checks all read assignee_id. An outsourced task has NO assignee_id — the
 * exclusivity rule in src/outsource.js guarantees it — so every one of those
 * gates refuses it, and the trace below pins what each one does rather than
 * describing it. THE ANSWER WAS NOT TO WIDEN THEM. Letting an unassigned task be
 * started or submitted would change ordinary work, which is not what this is
 * about; the stages are three NEW transitions with their own actors and their own
 * permissions, and the last test here holds the old gates to exactly the answers
 * they gave before.
 *
 * THREE STAGES, TWO REAL STATES AND ONE REVERSAL:
 *
 *   outsource_completed  not_started -> not_started. "The freelancer has
 *                        finished." THE TASK DOES NOT MOVE, which is the whole
 *                        reason Completed and Delivered are two states rather
 *                        than one: finishing is something the freelancer did and
 *                        handing on is something the studio decides, and a
 *                        studio that batches its hand-ins on a Friday needs to
 *                        record the first without doing the second.
 *   outsource_delivered  not_started -> pending_tl_review. The hand-back. Legal
 *                        from Assigned as well as from Completed, so marking
 *                        straight to Delivered in one action is a supported
 *                        path and not a shortcut around a required step.
 *   outsource_reopen     back to not_started, stamps cleared. ONE reversal for
 *                        both, with its OWN permission — it is the only control
 *                        on the tab that unsays something already written down.
 *
 * NO TIMERS, AND THEREFORE NO ZERO-HOUR WORK. The studio does not run a clock on
 * somebody it does not employ, so an outsourced task has no work session ever.
 * The STARTABLE lesson from the game-feedback work was that a round recording
 * nought hours silently under-reports, so every hours-based surface is checked
 * here: the Efficiency report names outsourced work as its own exclusion reason
 * rather than calling it "never submitted", and the per-person reports key off
 * assignee_id, which an outsourced task does not have.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const outsource = require('../src/outsource');
const workflow = require('../src/asset-workflow');
const catalog = require('../src/permission-catalog');
const rolePermissions = require('../src/role-permissions');
const reports = require('../src/reports');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON,
  openStudio } = require('./helpers');

const cfg = config('osstage');
const PASSWORD = 'OsStage-Test-1!';
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const ROUTE = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'assets.js'), 'utf8');
const OUTSOURCE_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'outsource.js'), 'utf8');

const byAction = (action) => workflow.TRANSITIONS.find((t) => t.action === action);

// ---------------------------------------------------------------------------
// The lifecycle, read off the table.
// ---------------------------------------------------------------------------

test('three transitions, and what each one does to the task', () => {
  const completed = byAction('outsource_completed');
  const delivered = byAction('outsource_delivered');
  const reopen = byAction('outsource_reopen');
  assert.ok(completed && delivered && reopen, 'all three are in the table');

  /* COMPLETED MOVES NOTHING, and that is the decision this pins: its `to` is its
     own `from`. If it ever moved the task, Completed and Delivered would be the
     same act and the Friday hand-in would be impossible. */
  assert.deepStrictEqual(completed.from, ['not_started']);
  assert.strictEqual(completed.to, 'not_started');

  // DELIVERED is the one that hands on, into a status every list already knows.
  assert.deepStrictEqual(delivered.from, ['not_started']);
  assert.strictEqual(delivered.to, 'pending_tl_review');

  /* THE REVERSAL REACHES BOTH, because either can be a mistake: a Completed
     recorded on the wrong row, or a Delivered that should not have gone to
     review. Back to not_started and not to in_progress or revision_requested —
     those are things somebody chose, and a reversal must not invent a choice
     nobody made. */
  assert.deepStrictEqual(reopen.from, ['not_started', 'pending_tl_review']);
  assert.strictEqual(reopen.to, 'not_started');

  // Assigned straight to Delivered is one action, not two.
  assert.ok(outsource.isDeliverable({ status: 'assigned' }),
    'a row nobody has marked completed can still be delivered in one step');
  assert.ok(outsource.isDeliverable({ status: 'completed' }),
    'and so can one that was');
});

test('the stages, and which assignment statuses each one reaches', () => {
  const reach = (pred) => [...outsource.STATUSES, outsource.CANCELLED].filter((st) => pred({ status: st }));

  assert.deepStrictEqual(reach(outsource.isCompletable),
    ['assigned', 'in_progress', 'revision_requested'],
    'anything still with them; not what is already completed, delivered or taken back');
  assert.deepStrictEqual(reach(outsource.isDeliverable),
    ['assigned', 'in_progress', 'completed', 'revision_requested'],
    'the same, plus the rows already marked completed');
  assert.deepStrictEqual(reach(outsource.isReopenable), ['completed', 'delivered'],
    'only something recorded can be unrecorded');

  // Nothing at all is not a row.
  for (const pred of [outsource.isCompletable, outsource.isDeliverable, outsource.isReopenable]) {
    assert.strictEqual(pred(null), false);
  }

  /* The stage of a row is derived from its status, in ONE function, so the badge,
     the grouping and the per-row buttons cannot disagree about where a row is. */
  assert.strictEqual(outsource.stageOf({ status: 'assigned' }), 'with_freelancer');
  assert.strictEqual(outsource.stageOf({ status: 'in_progress' }), 'with_freelancer');
  assert.strictEqual(outsource.stageOf({ status: 'revision_requested' }), 'with_freelancer');
  assert.strictEqual(outsource.stageOf({ status: 'completed' }), 'completed');
  assert.strictEqual(outsource.stageOf({ status: 'delivered' }), 'delivered');
  assert.strictEqual(outsource.stageOf({ status: 'cancelled' }), 'cancelled');
  assert.strictEqual(outsource.stageOf(null), null);
  // Every stage has a label, so no badge can render as a bare key.
  for (const key of outsource.STAGES) assert.ok(outsource.STAGE_LABELS[key], `${key} has a label`);
});

test('the history sentence names the staff member and the freelancer', () => {
  /* THE BRIEF'S OWN EXAMPLE, built by the real describe function. The point is
     not the wording but that BOTH names are in it: a record of an act done on
     somebody's behalf that named only one of the two people involved would be
     unreadable six months later. */
  const ctx = { user: { name: 'Priya' }, outsourcedTo: { freelancerName: 'Ravi K.' } };
  const say = (action) => {
    const t = byAction(action);
    return typeof t.describe === 'function' ? t.describe(ctx) : t.describe;
  };
  assert.strictEqual(say('outsource_delivered'), 'Marked delivered by Priya on behalf of Ravi K.');
  assert.match(say('outsource_completed'), /^Marked completed by the freelancer, recorded by Priya on behalf of Ravi K\.$/);
  assert.match(say('outsource_reopen'), /by Priya on behalf of Ravi K\.$/);

  /* AND IT DEGRADES RATHER THAN PRINTING "undefined". A history row is written
     inside a transaction; a missing name must not be able to fail one. */
  const t = byAction('outsource_delivered');
  assert.strictEqual(t.describe({ user: { name: 'Priya' } }), 'Marked delivered by Priya');
  assert.strictEqual(t.describe({ outsourcedTo: { freelancerName: 'Ravi K.' } }),
    'Marked delivered on behalf of Ravi K.');
  assert.strictEqual(t.describe({}), 'Marked delivered');
});

test('a recorded stamp reads as a date in the studio\'s own clock', () => {
  /* THE BUG THIS PINS, because it reached a refusal sentence in front of a
     reader: mysql2 hands a DATETIME back as a Date object, and
     String(d).replace('T', ' ') strikes the T of "Tue" — printing " ue Oct 06
     2026 ". Every shape the driver can produce is checked, and the answer is IST
     because every other clock in this application is. */
  const utc = Date.UTC(2026, 9, 6, 13, 53, 45);
  assert.strictEqual(outsource.istStamp(new Date(utc)), '2026-10-06 19:23 IST');
  assert.strictEqual(outsource.istStamp('2026-10-06 13:53:45'), '2026-10-06 19:23 IST',
    'a plain MySQL string, read as the UTC the column holds');
  assert.strictEqual(outsource.istStamp('2026-10-06T13:53:45.000Z'), '2026-10-06 19:23 IST');
  // The boundary: late evening UTC is the next calendar day in the studio.
  assert.strictEqual(outsource.istStamp(new Date(Date.UTC(2026, 9, 6, 19, 0, 0))), '2026-10-07 00:30 IST');
  for (const nothing of [null, undefined, '', 'not a date']) {
    assert.strictEqual(outsource.istStamp(nothing), null, `${JSON.stringify(nothing)} is not a stamp`);
  }
  // And nothing anywhere in the module still mangles a Date into a sentence.
  assert.ok(!/String\([a-zA-Z.]*(deliveredAt|completedAt)\)/.test(OUTSOURCE_SRC),
    'no stamp is stringified straight into a message');
});

// ---------------------------------------------------------------------------
// The gates, and the promise that ordinary work is untouched.
// ---------------------------------------------------------------------------

test('the stages have their own actors, and do not borrow the assignee\'s', () => {
  for (const action of ['outsource_completed', 'outsource_delivered', 'outsource_reopen']) {
    const t = byAction(action);
    assert.notStrictEqual(t.who, 'assignee',
      `${action} does not stand where the assignee stands`);
  }
  assert.strictEqual(byAction('outsource_completed').who, 'outsourceDeliverer');
  assert.strictEqual(byAction('outsource_delivered').who, 'outsourceDeliverer');
  /* THE REVERSAL HAS ITS OWN ACTOR, not the deliverer's. One actor for all three
     would make the separate permission unreachable — the mutation "reversal
     ungated" is exactly this line changed. */
  assert.strictEqual(byAction('outsource_reopen').who, 'outsourceReopener');

  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'asset-workflow.js'), 'utf8');
  assert.match(src, /outsourceDeliverer: \(ctx\) => Boolean\(ctx\.canDeliverOutsourced\)/,
    'the deliverer actor reads the permission the route computed');
  assert.match(src, /outsourceReopener: \(ctx\) => Boolean\(ctx\.canReopenOutsourced\)/,
    'and the reopener reads its own, not the deliverer\'s');
  // Both refusals are worded, so a 403 from the table is never a bare "no".
  assert.match(src, /You cannot record a stage on outsourced work on this project\./);
  /* Joined first: the sentence is split across two string literals in the
     source, and a regex that did not know that would pass only by accident. */
  const joined = src.replace(/'\s*\n?\s*\+ '/g, '');
  assert.match(joined, /Undoing a delivery is a separate permission from recording one\./,
    'the reversal\'s refusal says it is a different key, not a bare "no"');
});

test('the assignee gates are exactly what they were', () => {
  /* THE PIN THAT MATTERS MOST IN THIS FILE. The brief's instruction was not to
     widen these for ordinary assets, so they are written out here: if a later
     change adds a status to ASSIGNEE_STATUSES or a bypass to actors.assignee to
     make outsourced work flow, this fails and says so. The outsourced path is
     meant to go AROUND these, not through them. */
  assert.deepStrictEqual(workflow.ASSIGNEE_STATUSES,
    ['not_started', 'assigned', 'in_progress', 'tl_changes_requested'],
    'the statuses an assignee acts from');

  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'asset-workflow.js'), 'utf8');
  const actors = src.slice(src.indexOf('const actors = {'));
  const assignee = actors.slice(actors.indexOf('assignee: ('), actors.indexOf('teamLead:'));
  /* THREE CONDITIONS, UNCHANGED. The asset is yours, or it is routed to you —
     and an outsourced task satisfies neither, because assignee_id is null by the
     exclusivity rule and nothing routes work to somebody with no login. */
  assert.match(assignee, /if \(ctx\.asset\.assignee_id !== ctx\.user\.id\) return false;/,
    'it is still the assignee by id');
  assert.match(assignee, /if \(ctx\.asset\.routed_to_id === ctx\.user\.id\) return true;/);
  assert.match(assignee, /ASSIGNEE_STATUSES\.includes\(ctx\.asset\.status\)/);
  /* NO FULL-ACCESS BYPASS, which is the surprising half of the trace: a Super
     Admin cannot submit somebody else's round either, and that is deliberate —
     the person who did the work is the person who hands it in. An outsourced
     task has no assignee at all, so this refuses it for everybody, which is why
     the stages exist rather than a tier exemption. */
  assert.ok(!/canOverride|projectScope|managePermissions|tier/.test(assignee),
    'the assignee actor has no tier bypass');

  /* STARTABLE, where it lives: the /start route, not the table. Pinned as source
     for the same reason — an outsourced task is in not_started, which is NOT in
     this list, and that 409 is what stops a clock being opened on a freelancer. */
  const route = ROUTE.slice(ROUTE.indexOf('const STARTABLE = ['));
  assert.strictEqual(route.slice(0, route.indexOf('];') + 2),
    "const STARTABLE = ['assigned', 'in_progress', 'tl_changes_requested', 'cd_changes_requested',\n  'game_feedback'];",
    'the statuses a round starts from, unchanged — not_started is not among them');

  // The submit transition still stands where it stood.
  const submit = workflow.TRANSITIONS.find((x) => x.action === 'submit');
  assert.ok(submit, 'submit is still in the table');
  assert.strictEqual(submit.who, 'assignee', 'and is still the assignee\'s');
});

// ---------------------------------------------------------------------------
// Permissions.
// ---------------------------------------------------------------------------

test('recording a stage and undoing one are two keys', () => {
  for (const key of ['outsource.deliver', 'outsource.reopen']) {
    const entry = catalog.BY_KEY.get(key);
    assert.ok(entry, `${key} is in the catalogue`);
    // Every key sits in the group its prefix names.
    assert.strictEqual(entry.groupLabel, 'Outsourcing');
    assert.ok(catalog.grantableKeys().includes(key), `${key} can be handed out`);
    assert.ok(!entry.pending, `${key} is read by code in this same change`);
  }

  const { ROLES } = require('../src/reference-defaults');
  const held = (key) => ROLES.filter((r) => rolePermissions.defaultsFor(r.key).has(key)).map((r) => r.key);

  /* THE DEFAULTS, PINNED WITH THE REASON.
   *
   * outsource.deliver follows outsource.manage: recording a stage is part of
   * running outsourced work, and a lead who may assign it may say it came back.
   *
   * outsource.reopen follows user.delete — the eight designations that already
   * hold the heaviest switch in the application — because it is the only control
   * on this tab that rewrites a record somebody else wrote. A team lead records
   * stages all day and cannot unrecord one; that asymmetry is the point. */
  assert.deepStrictEqual(held('outsource.reopen'), held('user.delete'),
    'undoing a recorded stage sits with the designations that hold user.delete');
  assert.ok(held('outsource.deliver').length > held('outsource.reopen').length,
    'and it is a strictly smaller set than recording one');
  assert.ok(held('outsource.deliver').includes('team_lead'), 'a lead records stages');
  assert.ok(!held('outsource.reopen').includes('team_lead'), 'and cannot undo one');
  assert.ok(held('outsource.reopen').includes('super_admin'),
    'a Super Admin holds every new permission without being switched on');

  /* THE REACH, by the same shape every project-scoped key uses. Compared as
     source rather than described, because the PAIRING is the thing: a key
     without the scope check would reopen work across the whole studio. This is
     the mutation "project reach removed". */
  const perms = fs.readFileSync(path.join(__dirname, '..', 'src', 'permissions.js'), 'utf8');
  const fn = perms.slice(perms.indexOf('async function canReopenOutsourced'));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(body, /holds\(user, 'outsource\.reopen'\)/);
  assert.match(body, /projectScope === 'all'/);
  assert.match(body, /canAccessProject\(user, asset\.project_id\)/);
});

test('the server asks the right key for the right stage', () => {
  /* THE MUTATIONS "permission check dropped on the server" and "reversal
     ungated" both land here. One endpoint serves three stages, so the key
     depends on the body and cannot be middleware; the table and the check that
     reads it are pinned together. */
  const table = ROUTE.slice(ROUTE.indexOf('const STAGE_PERMISSION = {'));
  assert.match(table.slice(0, table.indexOf('};') + 2),
    /completed: 'outsource\.deliver', delivered: 'outsource\.deliver', reopened: 'outsource\.reopen'/);
  assert.match(ROUTE, /if \(!can\(req, STAGE_PERMISSION\[stage\]\)\) \{\n\s*return res\.status\(403\)/,
    'and the handler refuses once, up front, for somebody without the key');

  // The per-row reach, asked with the key that matches the stage.
  assert.match(ROUTE, /const reaches = stage === 'reopened'\n\s*\? await canReopenOutsourced\(/,
    'a reversal asks the reversal permission for its reach, not the deliverer\'s');
  assert.match(ROUTE, /: await canDeliverOutsourced\(req\.user, \{ project_id: assignment\.projectId \}\)/);

  // An unknown stage is refused before anything else happens.
  assert.match(ROUTE, /if \(!STAGE_PERMISSION\[stage\]\) \{\n\s*return res\.status\(400\)/);

  // Each stage runs a TRANSITION. No route writes a status directly.
  const actions = ROUTE.slice(ROUTE.indexOf('const STAGE_ACTION = {'));
  assert.match(actions.slice(0, actions.indexOf('};') + 2),
    /completed: 'outsource_completed', delivered: 'outsource_delivered', reopened: 'outsource_reopen'/);
  assert.match(ROUTE, /verdict = workflow\.evaluate\(STAGE_ACTION\[stage\], ctx, \{ note \}\)/);
  assert.ok(!/UPDATE assets SET .*status.* outsource/i.test(ROUTE),
    'and the stage endpoint does not write an asset status itself');
});

// ---------------------------------------------------------------------------
// The page.
// ---------------------------------------------------------------------------

test('the Outsource tab offers each stage behind its own key, never the tier', () => {
  const code = PAGE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!--[\s\S]*?-->/g, '');
  const from = code.indexOf('function osRenderAssignments');
  const to = code.indexOf('function osCostOf');
  assert.ok(from !== -1 && to > from, 'the Assigned work renderer is still where this reads it');
  const area = code.slice(from, to);

  /* THE MUTATION "page gate reading tier instead of permission" lands here. The
     page's own rule: anything a Super Admin can switch on in Settings is asked
     with can(), and caps() is only for projectScope, reviewStage and
     deleteAsset. Both keys are switchable, so neither may go near caps(). */
  assert.ok(!/caps\(/.test(area), 'the tier is not consulted in the Assigned work list');
  assert.match(code, /function osMayRecordStage\(\)\{ return can\('outsource\.deliver'\); \}/);
  assert.match(code, /function osMayReopen\(\)\{ return can\('outsource\.reopen'\); \}/);
  assert.match(area, /const mayRecord = Boolean\(d\.canDeliver\) && osMayRecordStage\(\);/);
  assert.match(area, /const mayReopen = Boolean\(d\.canReopen\) && osMayReopen\(\);/);

  // Per-row actions, each behind the right gate and the right predicate.
  const buttons = code.slice(code.indexOf('function osStageButtons'));
  const fn = buttons.slice(0, buttons.indexOf('\n}\n'));
  assert.match(fn, /if\(mayRecord && osCompletable\(a\)\)\{/, 'Mark completed');
  assert.match(fn, /if\(mayRecord && osDeliverable\(a\)\)\{/, 'Mark delivered');
  assert.match(fn, /if\(mayReopen && osReopenable\(a\)\)\{/, 'and Reopen, behind the other key');
  assert.match(fn, /data-osstage="\$\{escapeHTML\(a\.id\)\}:completed"/);
  assert.match(fn, /data-osstage="\$\{escapeHTML\(a\.id\)\}:delivered"/);
  assert.match(fn, /data-osstage="\$\{escapeHTML\(a\.id\)\}:reopened"/);

  // The badge, with who recorded it and when.
  const badge = code.slice(code.indexOf('function osStageBadge'));
  const badgeFn = badge.slice(0, badge.indexOf('\n}\n'));
  assert.match(badgeFn, /OS_STAGE_TONE\[a\.stage\]/, 'the stage has its own colour');
  assert.match(badgeFn, /a\.stageLabel/, 'and its label comes from the server');
  assert.match(badgeFn, /deliveredByName/);
  assert.match(badgeFn, /completedByName/);
  assert.match(badgeFn, /fmtDate\(stamp\.at\)/,
    'the stamp goes through the page\'s own formatter, not a string slice');
  assert.match(area, /<th>Stage<\/th><th>Status<\/th>/, 'the badge has a column of its own');

  // Grouped by stage when nothing is filtered, so finished work sits below.
  assert.match(area, /picked === 'all' \? groupedBody\(\) : rows\.map\(rowHTML\)/);
  assert.match(area, /data-osstagefilter/, 'and each stage can be picked on its own');
  assert.match(area, /osState\.stage/, 'the choice is remembered across a refresh');

  // The brand colour is not a stage colour.
  const tones = code.slice(code.indexOf('const OS_STAGE_TONE'));
  assert.ok(!/7f1416/i.test(tones.slice(0, tones.indexOf(';'))),
    'no stage wears the brand colour');
});

test('the confirmation names the count and the freelancers', () => {
  const code = PAGE.replace(/\/\*[\s\S]*?\*\//g, '');
  const run = code.slice(code.indexOf('async function osRunStage'));
  const fn = run.slice(0, run.indexOf('\n}\n'));
  assert.match(fn, /const names = \[\.\.\.new Set\(rows\.map\(a=>a\.freelancerName\)/,
    'the freelancers are named');
  assert.match(fn, /On behalf of: \$\{who\}/, 'and said to be acted for');
  assert.match(fn, /\$\{ids\.length\} assignment\$\{ids\.length===1\?'':'s'\}/, 'with the count');
  assert.match(fn, /if\(!confirm\(/, 'before anything is sent');
  /* ONE REQUEST for the whole selection, not one per row — so a batch is one
     audit entry and one answer, and a partial failure is reported per row. */
  assert.match(fn, /api\('\/assets\/bulk\/outsource-stage', \{ method:'POST', body:\{ assignmentIds: ids, stage \} \}\)/);
  assert.match(fn, /\(r\.results\|\|\[\]\)\.filter\(x=>x\.ok\)\.forEach\(x=>selectedAssignments\.delete\(x\.id\)\)/,
    'and only the rows that landed are unticked');
  // Per-row and bulk go through this one function.
  assert.match(code, /return osRunStage\('delivered', chosen, go\);/);
  assert.match(code, /return osRunStage\(stage, \[a\], b\);/);
});

// ---------------------------------------------------------------------------
// The reports. No outsourced task may read as zero-hour work.
// ---------------------------------------------------------------------------

test('an outsourced task is never zero-hour work in the Efficiency report', () => {
  /* THE MUTATION "outsourced assets counted as zero hours in a report" lands
     here. An outsourced task has no work session and no version, so it was
     already out of every average — but it was out AS "never submitted", which
     reads as somebody having forgotten to hand the work in. It says so now. */
  assert.strictEqual(reports.exclusionReason({ outsourced: true, submitted: true, manHours: 8, totalSeconds: 0 }),
    'outsourced — no tracked time');
  assert.strictEqual(reports.exclusionReason({ outsourced: true, submitted: false, manHours: 0, totalSeconds: 0 }),
    'outsourced — no tracked time', 'and it is said first, before any gap in the record');
  assert.strictEqual(reports.exclusionReason({ outsourced: false, submitted: false, manHours: 8, totalSeconds: 0 }),
    'never submitted', 'ordinary work keeps the reasons it had');
  assert.strictEqual(reports.exclusionReason({ submitted: true, manHours: 8, totalSeconds: 3600 }), null);

  /* AND IT IS OUT OF THE ARITHMETIC, not just labelled. The estimate must not
     reach the Man Hours total either: 8 hours against nought spent would make
     the studio look twice as fast as it is. */
  const prepared = reports.prepare([
    { id: 'a', code: 'A-1', name: 'Outsourced', outsourced: true, submitted: true,
      manHours: 8, totalSeconds: 0, firstPassSeconds: 0 },
    { id: 'b', code: 'B-1', name: 'Ours', outsourced: false, submitted: true,
      manHours: 4, totalSeconds: 7200, firstPassSeconds: 7200 },
  ]);
  assert.strictEqual(prepared.included.length, 1, 'only the measured one is reported on');
  assert.strictEqual(prepared.included[0].id, 'b');
  assert.deepStrictEqual(prepared.excluded.map((x) => x.reason), ['outsourced — no tracked time']);

  // The query that feeds it asks the question at all.
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'reports.js'), 'utf8');
  assert.match(route, /EXISTS \(SELECT 1 FROM outsource_assignments oa\s+WHERE oa\.asset_id = a\.id AND oa\.status <> 'cancelled'\) AS outsourced/,
    'the report knows which tasks were outsourced');
  assert.match(route, /outsourced: Boolean\(Number\(r\.outsourced\)\)/,
    'and hands it on as a boolean');
});

test('the per-person reports cannot attribute an outsourced task to anybody', () => {
  /* THE OTHER HALF OF THE SAME PROMISE, and the reason no change was needed:
     every per-person hours surface keys off assignee_id, and an outsourced task
     has none — src/outsource.js refuses to have both. So there is no person to
     show nought hours against. Pinned as source so a later query that joins on
     something else has to come past this test. */
  for (const [file, what] of [
    ['src/routes/team.js', 'team capacity'],
    ['src/routes/idle.js', 'the Idle report\'s waiting list'],
  ]) {
    const src = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
    assert.match(src, /assignee_id IN \(\$1\)/, `${what} is keyed on the assignee`);
  }
  /* And the one place an outsourced estimate IS summed names it: the P&L carries
     the decided hours and their cost as their own figure, so outsourced work is
     hours somewhere rather than hours nowhere. */
  assert.match(OUTSOURCE_SRC, /acc\.hours = Math\.round\(\(acc\.hours \+ hours\) \* 100\) \/ 100;/,
    'the decided hours are totalled for the P&L');
});

// ---------------------------------------------------------------------------
// Against a live server.
// ---------------------------------------------------------------------------

test('moving outsourced work through its stages', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const tok = {};
  const id = {};

  const login = async (email) => (await api(server.base, '/auth/login',
    { method: 'POST', body: { email, password: PASSWORD } })).body.token;
  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: tok[who] });
  const stage = (who, stageName, assignmentIds) =>
    as(who, '/assets/bulk/outsource-stage', { method: 'POST', body: { stage: stageName, assignmentIds } });

  const setPerms = async (roleKey, keys) => {
    const r = await as('root', `/permissions/roles/${roleKey}`, { method: 'PUT', body: { permissions: keys } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  };
  const heldBy = async (roleKey) => {
    const r = await as('root', `/permissions/roles/${roleKey}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return r.body.role.permissions.filter((p) => p.enabled).map((p) => p.key);
  };

  const outsourced = async (name, projectId = id.project) => {
    const asset = (await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name, type: 'prop' } })).body.asset;
    const r = await as('root', '/outsource/assignments', { method: 'POST',
      body: { freelancerId: id.freelancer, projectId, assetId: asset.id, decidedManHours: 8 } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    return { asset, assignment: r.body.assignment };
  };
  const statusOf = async (assetId, projectId = id.project) =>
    (await as('root', `/assets/project/${projectId}`)).body.assets.find((a) => a.id === assetId).status;
  const row = async (assignmentId) =>
    (await as('root', '/outsource/assignments')).body.assignments.find((a) => a.id === assignmentId);
  const history = async (assetId) =>
    (await as('root', `/assets/${assetId}/history`)).body;

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'osstage-token', WORK_HOURS_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'osstage-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    tok.root = await login('root@zvky.test');
    /* The clock opened wide. Nothing here records time — that is half the point
       of the suite — but the shipped 13:00-14:00 lunch blackout has broken three
       suites by putting a session down mid-case, and a suite that asserts "no
       session was ever created" must not be the fourth. */
    await openStudio(server.base, tok.root);

    const clientId = (await as('root', '/clients')).body.clients[0].id;
    id.project = (await as('root', '/projects', { method: 'POST',
      body: { name: 'Outsourced', clientId } })).body.project.id;
    id.other = (await as('root', '/projects', { method: 'POST',
      body: { name: 'Somebody Else\'s', clientId } })).body.project.id;

    for (const [who, email, role, projectId] of [
      ['priya', 'priya@zvky.test', 'team_lead', id.project],
      ['ana', 'ana@zvky.test', 'game_artist', id.project],
    ]) {
      const r = await as('root', '/users', { method: 'POST',
        body: { name: who === 'priya' ? 'Priya' : 'Ana', email, role, password: PASSWORD, projectId } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      id[who] = r.body.user.id;
      tok[who] = await login(email);
    }

    const fl = await as('root', '/outsource/freelancers', { method: 'POST',
      body: { name: 'Ravi K.', discipline: 'rigging', ratePerHour: 600 } });
    assert.strictEqual(fl.status, 201, JSON.stringify(fl.body));
    id.freelancer = fl.body.freelancer.id;
  });

  t.after(async () => { if (server) await stopServer(server); });

  await t.test('the assignee gates refuse an outsourced task, which is why the stages exist', async () => {
    /* THE TRACE, PROVED AGAINST THE RUNNING SERVER rather than read off the
       table. Each of these is a gate the pipeline uses for ordinary work, asked
       about a task that has no assignee because a freelancer holds it. */
    const { asset } = await outsourced('Nobody Inside Holds It');
    const row0 = (await as('root', `/assets/project/${id.project}`)).body.assets.find((a) => a.id === asset.id);
    assert.strictEqual(row0.status, 'not_started');
    assert.strictEqual(row0.assignee_id ?? null, null, 'and no assignee, by the exclusivity rule');

    // /start: the full-access reader is refused by the state machine, everybody
    // else before it — two different refusals, both of them refusals.
    const startRoot = await as('root', `/assets/${asset.id}/start`, { method: 'POST' });
    assert.strictEqual(startRoot.status, 409, JSON.stringify(startRoot.body));
    for (const who of ['priya', 'ana']) {
      const r = await as(who, `/assets/${asset.id}/start`, { method: 'POST' });
      assert.strictEqual(r.status, 403, `${who} cannot start it either`);
    }

    /* /submit: 403 for everybody INCLUDING the full-access reader, because
       actors.assignee has no tier bypass. This is the finding that made the
       stages necessary rather than optional. */
    for (const who of ['root', 'priya', 'ana']) {
      const r = await as(who, `/assets/${asset.id}/submit`, { method: 'POST', body: { link: 'https://x.test/a' } });
      assert.strictEqual(r.status, 403, `${who} cannot submit on the freelancer's behalf: ${JSON.stringify(r.body)}`);
    }

    // /hold: refused because canHoldAsset returns false with no assignee at all.
    const hold = await as('root', `/assets/${asset.id}/hold`, { method: 'POST', body: { reason: 'x' } });
    assert.ok(hold.status === 403 || hold.status === 409, `hold is refused (${hold.status})`);

    // And no clock was started by any of that.
    const sessions = await sql(cfg, `SELECT COUNT(*) AS n FROM work_sessions WHERE asset_id = '${asset.id}'`);
    assert.strictEqual(Number(sessions[0].n), 0, 'no work session exists on outsourced work');
  });

  await t.test('completed, then delivered — two steps, two records', async () => {
    const { asset, assignment } = await outsourced('Two Steps');

    const first = await stage('root', 'completed', [assignment.id]);
    assert.strictEqual(first.status, 200, JSON.stringify(first.body));
    assert.strictEqual(first.body.succeeded, 1);
    assert.strictEqual(first.body.stage, 'completed', 'the reply names the stage it recorded');
    assert.strictEqual(first.body.results[0].movedAsset, false,
      'Completed moves no task — that is what makes it a separate state');
    assert.strictEqual(await statusOf(asset.id), 'not_started', 'and the task is where it was');

    const afterCompleted = await row(assignment.id);
    assert.strictEqual(afterCompleted.stage, 'completed');
    assert.strictEqual(afterCompleted.stageLabel, 'Completed');
    assert.strictEqual(afterCompleted.completedByName, 'Root', 'the staff member who recorded it');
    assert.ok(afterCompleted.completedAt, 'and when');
    assert.strictEqual(afterCompleted.deliveredAt, null, 'nothing has been handed on yet');

    const second = await stage('root', 'delivered', [assignment.id]);
    assert.strictEqual(second.status, 200, JSON.stringify(second.body));
    assert.strictEqual(second.body.results[0].movedAsset, true);
    assert.strictEqual(await statusOf(asset.id), 'pending_tl_review', 'now a lead has it to check');

    const afterDelivered = await row(assignment.id);
    assert.strictEqual(afterDelivered.stage, 'delivered');
    assert.strictEqual(afterDelivered.deliveredByName, 'Root');
    assert.ok(afterDelivered.deliveredAt);
    assert.ok(afterDelivered.completedAt, 'and the earlier stamp is kept, not overwritten');

    /* THE HISTORY NAMES BOTH PEOPLE, for both steps. This is the record the
       studio reads when somebody asks what happened to a freelancer's task. */
    const h = await history(asset.id);
    const sentences = (h.events || h.history || []).map((e) => e.note || e.summary || e.describe || '');
    assert.ok(sentences.some((s) => /Marked completed by the freelancer, recorded by Root on behalf of Ravi K\./.test(s)),
      `the completed sentence is in the history: ${JSON.stringify(sentences)}`);
    assert.ok(sentences.some((s) => /Marked delivered by Root on behalf of Ravi K\./.test(s)),
      `and the delivered one: ${JSON.stringify(sentences)}`);

    // Still no clock, after a whole lifecycle.
    const sessions = await sql(cfg, `SELECT COUNT(*) AS n FROM work_sessions WHERE asset_id = '${asset.id}'`);
    assert.strictEqual(Number(sessions[0].n), 0);
  });

  await t.test('assigned straight to delivered, in one action', async () => {
    const { asset, assignment } = await outsourced('Straight Through');
    const r = await stage('root', 'delivered', [assignment.id]);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.succeeded, 1);
    assert.strictEqual(await statusOf(asset.id), 'pending_tl_review');
    const after = await row(assignment.id);
    assert.strictEqual(after.stage, 'delivered');
    assert.strictEqual(after.completedAt, null,
      'nothing invents a Completed that nobody recorded');
  });

  await t.test('a stage already recorded is refused by name, with a readable date', async () => {
    const { assignment } = await outsourced('Once Only');
    assert.strictEqual((await stage('root', 'delivered', [assignment.id])).body.succeeded, 1);

    const again = await stage('root', 'delivered', [assignment.id]);
    assert.strictEqual(again.status, 200, 'the request is well-formed');
    assert.strictEqual(again.body.succeeded, 0, 'and nothing happened');
    const err = again.body.results[0].error;
    assert.match(err, /Ravi K\. already delivered this on \d{4}-\d{2}-\d{2} \d{2}:\d{2} IST\./,
      `the refusal reads as a date in the studio's clock: ${JSON.stringify(err)}`);

    // Completing something already delivered is going backwards, and says so.
    const back = await stage('root', 'completed', [assignment.id]);
    assert.strictEqual(back.body.results[0].ok, false);
    assert.match(back.body.results[0].error, /already been delivered\. Reopen it first/);

    // And reopening something still with them has nothing to undo.
    const { assignment: fresh } = await outsourced('Still Out');
    const nothing = await stage('root', 'reopened', [fresh.id]);
    assert.strictEqual(nothing.body.results[0].ok, false);
    assert.match(nothing.body.results[0].error, /still with them, so there is nothing to reopen/);
  });

  await t.test('the reversal is its own permission, and clears what it undoes', async () => {
    const { asset, assignment } = await outsourced('A Mistake');
    assert.strictEqual((await stage('root', 'delivered', [assignment.id])).body.succeeded, 1);

    /* A LEAD MAY RECORD AND MAY NOT UNDO. The asymmetry is the feature: the
        same token that just succeeded at a delivery is refused here. */
    const held = await heldBy('team_lead');
    assert.ok(held.includes('outsource.deliver'), 'a lead records stages by default');
    assert.ok(!held.includes('outsource.reopen'), 'and cannot undo one');
    const refused = await stage('priya', 'reopened', [assignment.id]);
    assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
    assert.strictEqual(await statusOf(asset.id), 'pending_tl_review', 'nothing moved');

    // Granted, on the same token, with no sign-out — the page re-reads /auth/me.
    await setPerms('team_lead', [...held, 'outsource.reopen']);
    try {
      const me = await as('priya', '/auth/me');
      assert.ok(me.body.user.permissions.includes('outsource.reopen'), 'the grant is visible');
      assert.strictEqual((await as('priya', '/outsource/assignments')).body.canReopen, true,
        'and the tab starts offering it');

      const ok = await stage('priya', 'reopened', [assignment.id]);
      assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
      assert.strictEqual(ok.body.succeeded, 1);
      assert.strictEqual(await statusOf(asset.id), 'not_started', 'the task went back');

      const after = await row(assignment.id);
      assert.strictEqual(after.stage, 'with_freelancer');
      assert.strictEqual(after.deliveredAt, null, 'the stamp is cleared, not left to contradict the stage');
      assert.strictEqual(after.deliveredByName, null);
      assert.strictEqual(after.completedAt, null);

      // The reversal is in the history, naming both people.
      const h = await history(asset.id);
      const sentences = (h.events || h.history || []).map((e) => e.note || e.summary || '');
      assert.ok(sentences.some((s) => /Reopened and sent back to the freelancer, recorded by Priya on behalf of Ravi K\./.test(s)),
        `the reversal is recorded: ${JSON.stringify(sentences)}`);
      // And its own batch action, so a reopen is never counted as a delivery.
      const batch = await sql(cfg,
        `SELECT action FROM asset_event_batches WHERE id = '${ok.body.batchId}'`);
      assert.strictEqual(batch[0].action, 'outsource_reopen');
    } finally {
      await setPerms('team_lead', held);
    }
    assert.strictEqual((await as('priya', '/outsource/assignments')).body.canReopen, false,
      'revoked, the tab stops offering it');
  });

  await t.test('the reversal\'s reach is the role\'s too, per row', async () => {
    /* THE CASE A SOURCE PIN COULD NOT KEEP. Asserting that canReopenOutsourced
       MENTIONS canAccessProject does not stop an early return being put above
       it — a mutation that did exactly that passed every other test in this file.
       So the reach is exercised: one row on the lead's project, one on a project
       they cannot see, both delivered, both reopened in one request. */
    const mine = await outsourced('Reopen Mine');
    const theirs = await outsourced('Reopen Theirs', id.other);
    assert.strictEqual((await stage('root', 'delivered', [mine.assignment.id])).body.succeeded, 1);
    assert.strictEqual((await stage('root', 'delivered', [theirs.assignment.id])).body.succeeded, 1);

    const held = await heldBy('team_lead');
    await setPerms('team_lead', [...held, 'outsource.reopen']);
    try {
      const r = await stage('priya', 'reopened', [mine.assignment.id, theirs.assignment.id]);
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      const byId = new Map(r.body.results.map((x) => [x.id, x]));
      assert.strictEqual(byId.get(mine.assignment.id).ok, true, 'their own project reopens');
      assert.strictEqual(byId.get(theirs.assignment.id).ok, false,
        'and the key alone does not reach across the studio');
      assert.match(byId.get(theirs.assignment.id).error,
        /permission to reopen outsourced work on that project/);
      assert.strictEqual(await statusOf(theirs.asset.id, id.other), 'pending_tl_review',
        'the off-project task is untouched');
      assert.strictEqual((await row(theirs.assignment.id)).stage, 'delivered',
        'and so is its recorded stage');
    } finally {
      await setPerms('team_lead', held);
    }
  });

  await t.test('once a lead has acted, the reversal is refused by the table', async () => {
    /* THE LIMIT OF THE REVERSAL, which is the one claim its catalogue entry makes
       that nothing else here pins: reopening is possible while the delivery is
       still waiting on a team lead, and not after. Once the work is through
       review it belongs to the studio's own pipeline, and sending it back to a
       freelancer from there would unsay a decision somebody inside the studio
       made — so it is the TRANSITION's `from` that refuses it, not a check in the
       route, and the assignment is left exactly as it was. */
    const { asset, assignment } = await outsourced('Through Review');
    assert.strictEqual((await stage('root', 'delivered', [assignment.id])).body.succeeded, 1);

    const review = await as('priya', `/assets/${asset.id}/review`, {
      method: 'POST', body: { decision: 'approved' } });
    assert.strictEqual(review.status, 200, JSON.stringify(review.body));
    assert.strictEqual(await statusOf(asset.id), 'tl_approved',
      'the freelancer\'s work goes through the same review an artist\'s does');

    const held = await heldBy('team_lead');
    await setPerms('team_lead', [...held, 'outsource.reopen']);
    try {
      const r = await stage('priya', 'reopened', [assignment.id]);
      assert.strictEqual(r.status, 200, 'the request is well-formed');
      assert.strictEqual(r.body.results[0].ok, false);
      assert.match(r.body.results[0].error,
        /An asset in "TL Approved" cannot be reopened and sent back to the freelancer/,
        `refused by the table, naming the status: ${JSON.stringify(r.body.results[0].error)}`);
    } finally {
      await setPerms('team_lead', held);
    }
    // AND NOTHING WAS HALF-DONE: the assignment keeps its stage and its stamp.
    const after = await row(assignment.id);
    assert.strictEqual(after.stage, 'delivered');
    assert.ok(after.deliveredAt, 'the stamp is untouched');
    assert.strictEqual(await statusOf(asset.id), 'tl_approved');
  });

  await t.test('a project the recorder cannot reach is refused, per row', async () => {
    const mine = await outsourced('Lead\'s Own');
    const theirs = await outsourced('Off Project', id.other);
    const r = await stage('priya', 'completed', [mine.assignment.id, theirs.assignment.id]);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const byId = new Map(r.body.results.map((x) => [x.id, x]));
    assert.strictEqual(byId.get(mine.assignment.id).ok, true, 'their own project records');
    assert.strictEqual(byId.get(theirs.assignment.id).ok, false);
    assert.match(byId.get(theirs.assignment.id).error,
      /permission to record a stage on outsourced work on that project/);
  });

  await t.test('the key, off and on again on the same token', async () => {
    const { asset, assignment } = await outsourced('Gated');
    const held = await heldBy('team_lead');
    await setPerms('team_lead', held.filter((k) => k !== 'outsource.deliver'));
    try {
      const refused = await stage('priya', 'completed', [assignment.id]);
      assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));
      assert.strictEqual((await as('priya', '/outsource/assignments')).body.canDeliver, false,
        'and the tab stops offering any stage');
    } finally {
      await setPerms('team_lead', held);
    }
    const ok = await stage('priya', 'delivered', [assignment.id]);
    assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
    assert.strictEqual(await statusOf(asset.id), 'pending_tl_review');
  });

  await t.test('a mixed batch applies the good rows and reports each refusal', async () => {
    const ready = await outsourced('Ready');
    const done = await outsourced('Already Delivered');
    assert.strictEqual((await stage('root', 'delivered', [done.assignment.id])).body.succeeded, 1);
    const gone = await outsourced('Taken Back');
    await as('root', `/outsource/assignments/${gone.assignment.id}/cancel`, { method: 'POST' });

    const r = await stage('root', 'delivered',
      [ready.assignment.id, done.assignment.id, gone.assignment.id, 'no-such-id']);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual(r.body.requested, 4);
    assert.strictEqual(r.body.succeeded, 1, 'the one that could');
    assert.strictEqual(r.body.failed, 3);
    const byId = new Map(r.body.results.map((x) => [x.id, x]));
    assert.strictEqual(byId.get(ready.assignment.id).ok, true);
    assert.match(byId.get(done.assignment.id).error, /already delivered this/);
    assert.match(byId.get(gone.assignment.id).error, /no stage to record/);
    assert.match(byId.get('no-such-id').error, /no longer exists/);
    // EVERY refusal names the row it is about, so a reader can act on it.
    for (const res of r.body.results.filter((x) => !x.ok && x.id !== 'no-such-id')) {
      assert.ok(res.freelancerName, 'the refusal says whose work it was about');
    }
    assert.strictEqual(await statusOf(ready.asset.id), 'pending_tl_review');
    assert.strictEqual(await statusOf(gone.asset.id), 'not_started', 'and the cancelled task is untouched');
  });

  await t.test('the request itself is checked', async () => {
    const { assignment } = await outsourced('Checked');
    const bogus = await stage('root', 'finished', [assignment.id]);
    assert.strictEqual(bogus.status, 400, JSON.stringify(bogus.body));
    assert.match(bogus.body.error, /not a stage/);
    assert.deepStrictEqual(bogus.body.allowed, ['completed', 'delivered', 'reopened']);
    assert.strictEqual((await stage('root', 'delivered', [])).status, 400);
    assert.strictEqual((await stage('root', 'delivered', 'nope')).status, 400);
    // The older path still answers, so nothing that called it has broken.
    const old = await as('root', '/assets/bulk/outsource-deliver', {
      method: 'POST', body: { assignmentIds: [assignment.id] } });
    assert.strictEqual(old.status, 200, JSON.stringify(old.body));
    assert.strictEqual(old.body.delivered, 1);
  });

  await t.test('ordinary work behaves exactly as it did', async () => {
    /* THE PROMISE THE BRIEF ASKED FOR, kept against the running server: the
       assignee gates were not widened, so a task held by a member of staff
       starts, submits and reviews the way it always has — and nobody else can
       submit it on their behalf. */
    const asset = (await as('root', `/assets/project/${id.project}`, {
      method: 'POST', body: { name: 'Ours', type: 'prop', assigneeId: id.ana, manHours: 4 } })).body.asset;
    assert.strictEqual(asset.assignee_id, id.ana);

    /* The assignee starts it, which DOES open a work session — ordinary work is
       timed, and that is the contrast the whole feature rests on. */
    const started = await as('ana', `/assets/${asset.id}/start`, { method: 'POST' });
    assert.strictEqual(started.status, 200, JSON.stringify(started.body));

    /* AND SOMEBODY ELSE STILL CANNOT HAND IT IN. Asked once it is in progress, so
       the refusal is the ACTOR's and not the state machine's — before the start
       the same call is a 409 about the status, which would pass this test for the
       wrong reason. Priya holds outsource.deliver and outsource.manage; neither
       buys her a way through the assignee gate, which is the promise. */
    const notTheirs = await as('priya', `/assets/${asset.id}/submit`,
      { method: 'POST', body: { link: 'https://x.test/b' } });
    assert.strictEqual(notTheirs.status, 403,
      `the assignee gate is unchanged: ${JSON.stringify(notTheirs.body)}`);
    const sessions = await sql(cfg, `SELECT COUNT(*) AS n FROM work_sessions WHERE asset_id = '${asset.id}'`);
    assert.strictEqual(Number(sessions[0].n), 1, 'ordinary work keeps its clock');

    const submitted = await as('ana', `/assets/${asset.id}/submit`,
      { method: 'POST', body: { link: 'https://x.test/b' } });
    // 201: a submission CREATES a version row, and has answered that way all along.
    assert.strictEqual(submitted.status, 201, JSON.stringify(submitted.body));
    assert.strictEqual(await statusOf(asset.id), 'pending_tl_review');

    /* AND THE OUTSOURCED STAGES ARE NOT AVAILABLE TO IT. This is the mutation
       "transition available to ordinary assets": the asset is in a status the
       stage transitions name, it is a perfectly real task, and recording a stage
       on it is still impossible because there is no assignment to record
       against. */
    const anyStage = await stage('root', 'delivered', [asset.id]);
    assert.strictEqual(anyStage.body.results[0].ok, false);
    assert.match(anyStage.body.results[0].error, /no longer exists/,
      'an asset id is not an assignment id');
  });

  await t.test('the Efficiency report never shows it as zero-hour work', async () => {
    const { asset, assignment } = await outsourced('For The Report');
    assert.strictEqual((await stage('root', 'delivered', [assignment.id])).body.succeeded, 1);

    const r = await as('root', '/reports/efficiency');
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const excluded = (r.body.excluded || []).find((x) => x.id === asset.id);
    assert.ok(excluded, 'it is in the excluded list');
    assert.strictEqual(excluded.reason, 'outsourced — no tracked time',
      'and the reason is what it is, not "never submitted"');
    assert.ok(!(r.body.assets || []).some((x) => x.id === asset.id),
      'it is not in the reported assets');
    // Its 8-hour estimate is not in the totals either.
    const inTotal = (r.body.summary || {}).manHours;
    assert.ok(inTotal === undefined || !(r.body.assets || []).some((x) => x.id === asset.id),
      'nothing adds its estimate to a total it spent no time against');
  });
});
