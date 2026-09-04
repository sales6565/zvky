/* Hold and Resume.
 *
 * The feature is small — a close with a reason, and a start — but it reaches
 * three rules that were written when a round was one unbroken span, so this
 * tests the reaches rather than the buttons:
 *
 *   Time Spent must LOSE the held gap, because every reader sums session rows
 *   and the gap is the space between two of them. This is the whole point of
 *   the feature and the only thing that would silently produce wrong numbers.
 *
 *   The one-active-task rule must be freed by a hold and re-applied on resume.
 *   Freed, or holding achieves nothing; re-applied, or holding is a way around
 *   the rule rather than a use of it.
 *
 *   A held asset must not read as SUBMITTED. Both the panel and the Assets List
 *   took "nothing open" to mean "handed in", which was true until today.
 *
 * Timing is in whole seconds because work_sessions stores DATETIME, so the
 * waits below are real. Two seconds, not one: a hold and a resume inside the
 * same second are indistinguishable by design, and a test that sometimes lands
 * on that boundary would fail for a reason unrelated to what it checks.
 */
const test = require('node:test');
const assert = require('node:assert');
const workLog = require('../src/work-log');
const catalogue = require('../src/permission-catalog');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON, systemClientId } = require('./helpers');

const cfg = config('hold');
const wait = (seconds) => new Promise((r) => setTimeout(r, seconds * 1000));

test('holding is a permission every designation starts with', () => {
  /* Like timesheet.own, and for the same reason: recording what happened to
     your own work is not a privilege somebody grants you. The test pins the
     default rather than the wording, because a studio switching it off for one
     designation must stay possible. */
  const hold = catalogue.BY_KEY.get('asset.hold');
  assert.ok(hold, 'asset.hold is in the catalogue');
  assert.strictEqual(hold.impliedBy({}), true, 'on by default for a role with no capabilities at all');
  assert.ok(catalogue.KEYS.includes('asset.hold'));
});

test('hold and resume', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Hold-This-1!';
  let server;
  const token = {};
  const people = {};
  let projectId;

  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });
  const makeAsset = async (name, assigneeId) => (await as('root', `/assets/project/${projectId}`, {
    method: 'POST', body: { name, type: 'prop', assigneeId: assigneeId || people.ana },
  })).body.asset;
  const start = (who, id) => as(who, `/assets/${id}/start`, { method: 'POST' });
  const hold = (who, id, note) => as(who, `/assets/${id}/hold`, { method: 'POST', body: { note } });
  const resume = (who, id) => as(who, `/assets/${id}/resume`, { method: 'POST' });
  const submit = (who, id) => as(who, `/assets/${id}/submit`, {
    method: 'POST', body: { link: 'https://drive.zvky.test/work' },
  });
  const worklog = async (who, id) => (await as(who, `/assets/${id}/worklog`)).body.work;
  // The asset as the board and the Assets List receive it.
  const onBoard = async (who, id) => (await as(who, `/assets/project/${projectId}`)).body.assets
    .find((x) => x.id === id);

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'hold-token' });
    await call('/auth/bootstrap', { method: 'POST',
      body: { token: 'hold-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    const login = async (email) => (await call('/auth/login', { method: 'POST',
      body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@zvky.test');
    const client = await systemClientId(server.base, token.root);
    projectId = (await as('root', '/projects', { method: 'POST',
      body: { clientId: client, name: 'Interrupted' } })).body.project.id;
    const person = async (name, email, role) => (await as('root', '/users', { method: 'POST', body: {
      name, email, role, password: PASSWORD, projectId,
    } })).body.user.id;
    people.ana = await person('Ana', 'ana@zvky.test', 'game_artist');
    people.bo = await person('Bo', 'bo@zvky.test', 'game_artist');
    token.ana = await login('ana@zvky.test');
    token.bo = await login('bo@zvky.test');
  });

  t.after(() => stopServer(server));

  await t.test('the held gap is left out of Time Spent', async () => {
    /* The measurement this feature exists for. Two seconds worked, two seconds
       held, two seconds worked: Time Spent must be about four, not about six.
       Asserted as a range because these are real clock seconds and a loaded
       machine can add one — but the range is far tighter than the gap it is
       distinguishing, so a hold that failed to exclude anything cannot pass. */
    const asset = await makeAsset('Held Gate');
    assert.strictEqual((await start('ana', asset.id)).status, 200);
    await wait(2);
    assert.strictEqual((await hold('ana', asset.id, 'client call')).status, 200);
    await wait(2);
    assert.strictEqual((await resume('ana', asset.id)).status, 200);
    await wait(2);
    await submit('ana', asset.id);

    const work = await worklog('ana', asset.id);
    assert.ok(work.totalSeconds >= 3 && work.totalSeconds <= 5,
      `about four seconds of work, not the six that elapsed — got ${work.totalSeconds}`);

    /* And the round is still ONE round. currentRound counts submissions, and a
       hold submits nothing, so the resumed stretch belongs where it left. Two
       rounds here would mean the rework breakdown gains a phantom pass every
       time somebody takes a lunch break. */
    assert.strictEqual(work.rounds.length, 1, 'a hold does not open a new round');
    assert.strictEqual(work.rounds[0].round, 1);

    // Two session rows, one round: the shape the table has always allowed.
    const rows = await sql(cfg,
      'SELECT ended_reason FROM work_sessions WHERE asset_id = ? ORDER BY started_at', [asset.id]);
    assert.deepStrictEqual(rows.map((r) => r.ended_reason), ['held', 'submitted']);
  });

  await t.test('holding frees the slot, and resuming asks for it back', async () => {
    const first = await makeAsset('First Thing');
    const second = await makeAsset('Second Thing');
    assert.strictEqual((await start('ana', first.id)).status, 200);

    // The rule as it stands: one at a time.
    const refused = await start('ana', second.id);
    assert.strictEqual(refused.status, 409);
    assert.match(refused.body.error, /Finish your current task/i);

    // Hold, and the slot is free. This is the request in one assertion.
    assert.strictEqual((await hold('ana', first.id, null)).status, 200);
    assert.strictEqual((await start('ana', second.id)).status, 200,
      'holding the first task releases the second');

    /* And resuming is subject to the same rule, or Hold would be a way around
       it: hold A, start B, resume A, two open at once. */
    const blocked = await resume('ana', first.id);
    assert.strictEqual(blocked.status, 409, JSON.stringify(blocked.body));
    assert.match(blocked.body.error, /Finish your current task/i);
    assert.strictEqual(blocked.body.activeWork.assetId, second.id, 'and it names what to finish');

    // Clear the second, and the first resumes.
    await submit('ana', second.id);
    assert.strictEqual((await resume('ana', first.id)).status, 200);
    await submit('ana', first.id);
  });

  await t.test('a held task does not read as submitted', async () => {
    /* The bug this would have been. Both the panel and the Assets List took
       "nothing open" to mean "handed in", which was true when a round was one
       span. A held task has nothing open either, and would have shown a submit
       stamp of the moment somebody put it down — to its owner, and to every
       lead looking for something to review. */
    const asset = await makeAsset('Not Submitted');
    await start('ana', asset.id);
    await wait(1);
    await hold('ana', asset.id, 'waiting on refs');

    const work = await worklog('ana', asset.id);
    assert.strictEqual(work.submittedAt, null, 'no submit stamp on work that was not submitted');
    assert.strictEqual(work.open, false, 'and it is not open either — it is held');
    assert.ok(work.held, 'which is a state of its own');
    assert.strictEqual(work.held.note, 'waiting on refs');
    assert.strictEqual(work.rounds[0].submittedAt, null, 'the round says the same');

    // The list payload agrees with the panel, which is the point of deriving
    // both from one predicate.
    const row = await onBoard('ana', asset.id);
    assert.strictEqual(row.submitted_at, null);
    assert.strictEqual(row.work_open, false);
    assert.ok(row.held, 'and the board card can draw its badge');
    assert.strictEqual(row.held.note, 'waiting on refs');

    // Resuming clears it, and submitting stamps it for real.
    await resume('ana', asset.id);
    assert.strictEqual((await worklog('ana', asset.id)).held, null, 'resumed is no longer held');
    assert.strictEqual((await onBoard('ana', asset.id)).held, null);
    await submit('ana', asset.id);
    const done = await worklog('ana', asset.id);
    assert.ok(done.submittedAt, 'a real submission does stamp');
    assert.strictEqual(done.held, null);
  });

  await t.test('the status does not move, in either direction', async () => {
    /* Held is not a stage. If a hold moved the asset out of In Progress, every
       tab rule, every export and every board column would have to learn a word
       the state machine does not know — and closeIfWorkStopped would have
       closed the session a second time on the way. */
    const asset = await makeAsset('Still In Progress');
    await start('ana', asset.id);
    assert.strictEqual((await onBoard('ana', asset.id)).status, 'in_progress');
    await hold('ana', asset.id, null);
    assert.strictEqual((await onBoard('ana', asset.id)).status, 'in_progress',
      'a held asset stays exactly where it was');
    await resume('ana', asset.id);
    assert.strictEqual((await onBoard('ana', asset.id)).status, 'in_progress');
    await submit('ana', asset.id);
  });

  await t.test('only the person holding the task can put it down', async () => {
    const asset = await makeAsset('Ana\'s Work');
    await start('ana', asset.id);

    const byColleague = await hold('bo', asset.id, 'not mine to hold');
    assert.strictEqual(byColleague.status, 403);
    assert.match(byColleague.body.error, /assigned to/i);

    /* Not even a Super Admin, who may stamp a START on somebody else's asset
       for oversight. Holding is a different kind of act — to the person doing
       the work it is indistinguishable from the app losing their session — so
       it is stricter on purpose. A lead who wants the work stopped reassigns it
       or moves its stage, both of which name who did it in the history. */
    const byRoot = await hold('root', asset.id, 'oversight');
    assert.strictEqual(byRoot.status, 403, JSON.stringify(byRoot.body));

    assert.strictEqual((await hold('ana', asset.id, null)).status, 200, 'but its owner can');
    await resume('ana', asset.id);
    await submit('ana', asset.id);
  });

  await t.test('holding what is not open, and resuming what is not held', async () => {
    const asset = await makeAsset('Untouched');

    const early = await hold('ana', asset.id, null);
    assert.strictEqual(early.status, 409);
    assert.match(early.body.error, /Start the work before/i);

    const notHeld = await resume('ana', asset.id);
    assert.strictEqual(notHeld.status, 409);
    assert.match(notHeld.body.error, /not on hold/i);

    await start('ana', asset.id);
    const running = await resume('ana', asset.id);
    assert.strictEqual(running.status, 409);
    assert.match(running.body.error, /already under way/i);

    await hold('ana', asset.id, null);
    const twice = await hold('ana', asset.id, null);
    assert.strictEqual(twice.status, 409, 'holding twice is refused, not silently repeated');
    assert.match(twice.body.error, /already on hold/i);
    assert.ok(twice.body.held, 'and it says since when');

    await resume('ana', asset.id);
    await submit('ana', asset.id);
  });

  await t.test('nothing stops somebody holding several tasks at once', async () => {
    /* Confirmed as the intended behaviour rather than discovered: a hold closes
       the session, so there is nothing left to enforce a cap against, and a cap
       would be a rule to explain for no benefit. What matters is that each one
       stays visible so it cannot be quietly forgotten. */
    const a1 = await makeAsset('One');
    const a2 = await makeAsset('Two');
    for (const a of [a1, a2]) {
      await start('ana', a.id);
      assert.strictEqual((await hold('ana', a.id, null)).status, 200);
    }
    const assets = (await as('ana', `/assets/project/${projectId}`)).body.assets;
    const heldNow = assets.filter((x) => x.held).map((x) => x.id);
    assert.ok(heldNow.includes(a1.id) && heldNow.includes(a2.id), 'both are held and both show it');

    for (const a of [a1, a2]) { await resume('ana', a.id); await submit('ana', a.id); }
  });

  await t.test('handing a held task on gives the new person a clean start', async () => {
    /* Held is derived from the newest session belonging to whoever holds the
       asset NOW. So a reassignment clears it without anything having to clear
       it — and the old holder's hours stay in the asset's lifetime total, which
       a handover must never shorten. */
    const asset = await makeAsset('Passed On');
    await start('ana', asset.id);
    await wait(1);
    await hold('ana', asset.id, 'off sick');
    assert.ok((await onBoard('ana', asset.id)).held);

    await as('root', `/assets/${asset.id}`, { method: 'PATCH', body: { assigneeId: people.bo } });
    const afterHandover = await onBoard('bo', asset.id);
    assert.strictEqual(afterHandover.held, null, 'Bo did not inherit Ana\'s hold');

    const work = await worklog('bo', asset.id);
    assert.ok(work.totalSeconds >= 1, 'and Ana\'s time is still on the asset');
    assert.strictEqual(work.currentSeconds, 0, 'while Bo\'s own stretch starts at nothing');
  });

  await t.test('the Efficiency report says which assets had time held back', async () => {
    /* Time Spent already excludes the gap — it is a SUM over rows, and the gap
       is between them. What the report has to add is honesty about WHICH
       assets that happened to, because two assets showing the same hours mean
       different things if one had a day taken out of it. */
    const before = (await as('root', '/reports/efficiency')).body;
    const heldBefore = before.held ? before.held.assets : 0;

    const asset = await makeAsset('Reported');
    await as('root', `/assets/${asset.id}`, { method: 'PATCH', body: { manHours: 4 } });
    await start('ana', asset.id);
    await wait(1);
    await hold('ana', asset.id, null);
    await resume('ana', asset.id);
    await wait(1);
    await submit('ana', asset.id);

    const after = (await as('root', '/reports/efficiency')).body;
    assert.strictEqual(after.held.assets, heldBefore + 1,
      'the asset that was held is counted, so the report can qualify itself');
  });

  await t.test('a hold and a resume are in the asset\'s history', async () => {
    const asset = await makeAsset('On The Record');
    await start('ana', asset.id);
    await hold('ana', asset.id, 'power cut');
    await resume('ana', asset.id);

    const events = await sql(cfg,
      'SELECT action, from_status, to_status, note FROM asset_events WHERE asset_id = ? ORDER BY created_at',
      [asset.id]);
    const hold_ = events.find((e) => e.action === 'hold');
    assert.ok(hold_, 'the hold is recorded');
    assert.strictEqual(hold_.note, 'power cut', 'with what was said about it');
    assert.strictEqual(hold_.from_status, hold_.to_status,
      'and as a row that moved nothing, because it moved nothing');
    assert.ok(events.find((e) => e.action === 'resume'), 'so is the resume');

    await submit('ana', asset.id);
  });

  await t.test('the reason is optional, and is not required to be useful', async () => {
    const asset = await makeAsset('Wordless');
    await start('ana', asset.id);
    assert.strictEqual((await hold('ana', asset.id, '   ')).status, 200,
      'whitespace is the same as saying nothing');
    const work = await worklog('ana', asset.id);
    assert.ok(work.held, 'still held');
    assert.strictEqual(work.held.note, null, 'just without a reason');
    await resume('ana', asset.id);
    await submit('ana', asset.id);
  });

  await t.test('a studio that switches the permission off keeps working', async () => {
    /* Turning it off must not strand anybody. A task already held is resumed
       with the same button that starts one, and Time Spent goes back to
       counting every hour between the stamps — which is where it was before
       this feature existed. */
    const asset = await makeAsset('No Longer Allowed');
    await start('ana', asset.id);
    await hold('ana', asset.id, null);

    const current = (await as('root', '/permissions/roles/game_artist')).body.role.permissions
      .filter((p) => p.enabled).map((p) => p.key);
    assert.ok(current.includes('asset.hold'), 'an artist starts with it');
    const off = await as('root', '/permissions/roles/game_artist', { method: 'PUT',
      body: { permissions: current.filter((k) => k !== 'asset.hold') } });
    assert.strictEqual(off.status, 200, JSON.stringify(off.body));

    const refused = await hold('ana', asset.id, null);
    assert.strictEqual(refused.status, 403, 'holding is refused once the permission is gone');
    const cannotResume = await resume('ana', asset.id);
    assert.strictEqual(cannotResume.status, 403);

    // But Accept and Start still picks the held work up, because a held asset
    // has no open session and is still in a status its holder works in.
    assert.strictEqual((await start('ana', asset.id)).status, 200,
      'and nobody is stranded on work they can no longer resume');
    await submit('ana', asset.id);

    await as('root', '/permissions/roles/game_artist', { method: 'PUT', body: { permissions: current } });
  });
});

test('the held-time cutover is still readable as two eras', { skip: cfg ? false : SKIP_REASON }, async () => {
  /* cutover() tells the reports where `seconds` changed meaning, using
     ended_reason as the discriminator: old rows have none. Hold writes rows
     that DO have one, so they fall on the new side — which is right, because
     they are elapsed time like every other new row, just with the declared gaps
     missing. What the report must not do is lose the old boundary, and that is
     what this pins. */
  assert.strictEqual(workLog.REASONS.held, 'held');
  assert.ok(!workLog.WORK_CONTINUES.includes('held'),
    'held is not a status, so it can never appear in the list of statuses work continues in');
});
