/* A pause does not outlive the round it belongs to.
 *
 * THE BUG, AS REPORTED: "reassign an asset in TL Feedbacks back to the same
 * user with Reassign to Same User, and that user then cannot click Start."
 *
 * THE BUG, AS IT ACTUALLY WAS: nothing to do with reassignment, and nothing to
 * do with the status, the permissions or the one-active-task rule — all three
 * were correct, and the API accepted POST /start throughout. An artist still
 * working when the recording schedule put their clock down — at a break, or at
 * seven — and who then submitted, left a work_sessions row saying `off_hours`.
 * The round was over; the record said it was paused, for ever.
 *
 * Two readers believed it, and between them they left the artist with nothing:
 *
 *   Accept and Start is not offered while a task reads as paused, because a
 *      paused task has not stopped, it is waiting to be picked up.
 *   Resume is not offered for a pause the SCHEDULE made, because the schedule
 *      starts those itself and a button would be a lie about who is in charge.
 *
 * Each rule is right on its own. Together, on a stale row, they are a panel
 * with no buttons on it.
 *
 * WHY "REASSIGN TO SAME USER" IS WHERE IT SHOWED. A pause is read per person.
 * Hand the asset to somebody ELSE and the question moves to a person with no
 * rows on it, so the stale one is invisible and that path looked healthy.
 * Hand it back to the SAME person and it is still theirs. The reassignment was
 * the messenger.
 *
 * THE SECOND SYMPTOM, which nobody had reported yet: submitStamp reads a paused
 * row as "not handed in", so the same asset had no submitted_at at all — a
 * plainly submitted asset whose panel and Assets List had nothing in the
 * column.
 *
 * FIXED IN TWO PLACES, ON PURPOSE:
 *
 *   AT THE SOURCE. close() now settles a pause that the round's end overtook:
 *      the reason that really ended the round is written over it, leaving
 *      ended_at and seconds exactly where they were.
 *
 *   AND ON READ. The held predicate is scoped to the asset's current round, so
 *      a deployment that already has rows in this state is right again without
 *      a data migration. This file proves both halves separately, because a
 *      fix that only works on new data would leave the studio's own stuck
 *      assets stuck.
 */
const test = require('node:test');
const assert = require('node:assert');

const { config, resetSchema, startServer, stopServer, api, sql, openStudio, SKIP_REASON } = require('./helpers');

const cfg = config('pausedround');

// --- the settling rule itself, with no database ------------------------------

test('a pause is never settled by another pause', () => {
  /* The guard that stops the sweep relabelling somebody's hold, and the hold
   * relabelling the sweep's pause.
   *
   * No route reaches it today: every caller that passes a pause reason — the
   * auto-pause sweep, and Hold — only gets that far when a session is actually
   * open, and then close() takes the ordinary path and never settles anything.
   * It is a race away from mattering, and the failure would be silent and in
   * the record: a person told the studio put their work down when they did it
   * themselves, or the reverse.
   *
   * So it is tested where it lives rather than through an endpoint that cannot
   * currently get here. The database is a stub that answers "no open session"
   * and remembers what it was asked, which is the whole of what this needs. */
  const workLog = require('../src/work-log');
  const stub = () => {
    const asked = [];
    return {
      asked,
      query(text) {
        asked.push(String(text).replace(/\s+/g, ' ').trim());
        return Promise.resolve({ rows: [], result: { affectedRows: 0 } });
      },
    };
  };
  const settledBy = async (reason) => {
    const db = stub();
    const out = await workLog.close(db, 'asset-1', reason);
    assert.strictEqual(out.wasOpen, false, 'the stub has nothing open');
    return db.asked.some((q) => /^UPDATE work_sessions SET ended_reason/.test(q));
  };

  // The reasons that END a round settle a pause the round's end overtook.
  for (const reason of ['submitted', 'reassigned', 'unassigned', 'moved']) {
    assert.strictEqual(settledBy(reason) instanceof Promise, true);
  }
  return Promise.all([
    settledBy('submitted').then((y) => assert.ok(y, 'submitting settles it')),
    settledBy('reassigned').then((y) => assert.ok(y, 'a handover settles it')),
    settledBy('unassigned').then((y) => assert.ok(y, 'taking it off somebody settles it')),
    settledBy('moved').then((y) => assert.ok(y, 'moving the stage settles it')),
    // And the two that are pauses do not.
    settledBy('off_hours').then((y) => assert.ok(!y, 'the schedule does not overwrite a hold')),
    settledBy('held').then((y) => assert.ok(!y, 'and a hold does not overwrite the schedule')),
    settledBy(null).then((y) => assert.ok(!y, 'nor does a close with no reason at all')),
  ]);
});

test('a pause and the end of its round', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'PausedRound-1!';
  let server;
  let projectId;
  const tok = {};
  const id = {};

  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: tok[who] });
  const login = async (email) =>
    (await api(server.base, '/auth/login', { method: 'POST', body: { email, password: PASSWORD } })).body.token;

  const sessions = (assetId) => sql(cfg,
    `SELECT round, seconds, ended_reason, ended_at FROM work_sessions
      WHERE asset_id = '${assetId}' ORDER BY started_at, id`);
  const onBoard = async (assetId, who) => {
    const r = await as(who, `/assets/project/${projectId}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    return r.body.assets.find((a) => a.id === assetId);
  };
  /* What the panel decides, mirrored from public/index.html. Accept and Start
     is offered only when the task does not read as paused; Resume only for a
     pause a PERSON made. Written out because the bug was that both came back
     false at once, which no single assertion about either one would show. */
  const buttons = (a) => ({
    start: Boolean(!a.work_open && !a.held),
    resume: Boolean(a.held && !a.held.byStudio && !a.work_open),
  });

  let made = 0;
  const assignedAsset = async (who) => {
    const r = await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: `Round ${made += 1}`, type: 'prop', assigneeId: id[who] },
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    return r.body.asset.id;
  };

  /* The state the studio hit: started, put down by the SCHEDULE rather than by
   * the person, then submitted while the clock was already down.
   *
   * The pause is written through the database rather than by waiting for seven
   * o'clock, which is the only way to have this case at whatever hour the suite
   * runs. Everything after it — the submission, the review, the handover — goes
   * through the real endpoints, because those are what the bug was about. */
  const pausedThenSubmitted = async (who) => {
    const assetId = await assignedAsset(who);
    assert.strictEqual((await as(who, `/assets/${assetId}/start`, { method: 'POST' })).status, 200);
    await sql(cfg,
      `UPDATE work_sessions SET ended_at = NOW(), seconds = 3600, ended_reason = 'off_hours'
        WHERE asset_id = '${assetId}' AND ended_at IS NULL`);
    const sent = await as(who, `/assets/${assetId}/submit`, {
      method: 'POST', body: { link: 'https://example.com/v1' },
    });
    assert.strictEqual(sent.status, 201, JSON.stringify(sent.body));
    return assetId;
  };
  const requestChanges = (assetId) => as('lead', `/assets/${assetId}/review`, {
    method: 'POST', body: { decision: 'changes_requested', text: 'tighten it' },
  });

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'test-bootstrap-token', WORK_HOURS_SWEEP_MINUTES: '0',
    });
    await api(server.base, '/auth/bootstrap', {
      method: 'POST',
      body: { token: 'test-bootstrap-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD },
    });
    tok.root = await login('root@zvky.test');
    /* Hold the studio open, so the only pause in this file is the one each case
       writes on purpose. */
    await openStudio(server.base, tok.root);

    const make = async (key, name, email, role, teamLeadId) => {
      const r = await as('root', '/users', {
        method: 'POST', body: { name, email, role, password: PASSWORD, teamLeadId },
      });
      assert.strictEqual(r.status, 201, `${role}: ${JSON.stringify(r.body)}`);
      id[key] = r.body.user.id;
      tok[key] = await login(email);
    };
    await make('lead', 'Lena Lead', 'lead@zvky.test', 'team_lead');
    await make('ana', 'Ana Artist', 'ana@zvky.test', 'game_artist', id.lead);
    await make('ben', 'Ben Bhatt', 'ben@zvky.test', 'game_artist', id.lead);

    const clients = await as('root', '/clients');
    const project = await as('root', '/projects', {
      method: 'POST',
      body: { name: 'Roundhouse', clientId: clients.body.clients[0].id, teamLeadIds: [id.lead] },
    });
    assert.strictEqual(project.status, 201, JSON.stringify(project.body));
    projectId = project.body.project.id;
  });

  t.after(() => stopServer(server));

  /* --- the reported case --------------------------------------------------- */

  await t.test('Reassign to Same User leaves the asset startable', async () => {
    const assetId = await pausedThenSubmitted('ana');
    assert.strictEqual((await requestChanges(assetId)).status, 200);

    const back = await as('lead', `/assets/${assetId}/reassign`, {
      method: 'POST', body: { assigneeId: id.ana },
    });
    assert.strictEqual(back.status, 200, JSON.stringify(back.body));

    const a = await onBoard(assetId, 'ana');
    assert.strictEqual(a.status, 'assigned', 'the stage is right — it always was');
    assert.strictEqual(a.held, null, 'and the round it was paused in has been handed in');
    assert.deepStrictEqual(buttons(a), { start: true, resume: false },
      'Accept and Start is offered, which is the whole complaint');

    // And the server agrees, which it did even while the button was missing.
    assert.strictEqual((await as('ana', `/assets/${assetId}/start`, { method: 'POST' })).status, 200);
    await as('ana', `/assets/${assetId}/submit`, { method: 'POST', body: { link: 'https://example.com/v2' } });
  });

  await t.test('Reassign to Any User lands in exactly the same state', async () => {
    /* The studio's second step. The two paths differ only in who holds it
       afterwards, so the assertion is that everything else matches — including
       the stale row being gone, which on this path was never visible because
       the question is asked of the person who now holds it. */
    const assetId = await pausedThenSubmitted('ana');
    assert.strictEqual((await requestChanges(assetId)).status, 200);

    const over = await as('lead', `/assets/${assetId}/reassign`, {
      method: 'POST', body: { assigneeId: id.ben },
    });
    assert.strictEqual(over.status, 200, JSON.stringify(over.body));

    const a = await onBoard(assetId, 'ben');
    assert.strictEqual(a.status, 'assigned');
    assert.strictEqual(a.assignee_id, id.ben);
    assert.strictEqual(a.held, null);
    assert.deepStrictEqual(buttons(a), { start: true, resume: false },
      'the same startable state the same-user path reaches');

    assert.strictEqual((await as('ben', `/assets/${assetId}/start`, { method: 'POST' })).status, 200);
    await as('ben', `/assets/${assetId}/submit`, { method: 'POST', body: { link: 'https://example.com/v2' } });
  });

  /* --- and it was never really about reassigning --------------------------- */

  await t.test('the same asset is startable in TL Feedbacks with no reassignment at all', async () => {
    /* Where the bug actually lived. The reassignment was the messenger: an
       artist sent their own rework back to themselves through the ordinary
       pipeline hit it too, and had no way out of it either. */
    const assetId = await pausedThenSubmitted('ana');
    assert.strictEqual((await requestChanges(assetId)).status, 200);

    const a = await onBoard(assetId, 'ana');
    assert.strictEqual(a.status, 'tl_changes_requested');
    assert.strictEqual(a.held, null, 'the round it was paused in was handed in');
    assert.deepStrictEqual(buttons(a), { start: true, resume: false },
      'a panel with no buttons on it was the bug; Accept and Start is the way on');

    assert.strictEqual((await as('ana', `/assets/${assetId}/start`, { method: 'POST' })).status, 200);
    await as('ana', `/assets/${assetId}/submit`, { method: 'POST', body: { link: 'https://example.com/v2' } });
  });

  await t.test('and the round that was paused still says when it was handed in', async () => {
    /* The second symptom of the same row, which nobody had reported. A paused
       row is not a submission, so an asset that was plainly submitted had no
       submitted_at anywhere — not on the panel, not in the Assets List. */
    const assetId = await pausedThenSubmitted('ana');
    const a = await onBoard(assetId, 'ana');
    assert.ok(a.submitted_at, 'the asset says when it was handed in');
    const work = (await as('ana', `/assets/${assetId}/worklog`)).body.work;
    assert.ok(work.submittedAt, 'and so does the work log');
    assert.strictEqual(work.open, false);

    /* The hours are untouched: settling says WHY the stretch ended, never when.
       The clock really did stop at seven, not when Submit was pressed. */
    const rows = await sessions(assetId);
    assert.strictEqual(rows.length, 1);
    assert.strictEqual(Number(rows[0].seconds), 3600, 'the hour it recorded is the hour it recorded');
    assert.strictEqual(rows[0].ended_reason, 'submitted', 'and the reason is what ended the round');
    assert.strictEqual(String(work.totalSeconds), '3600');
    await requestChanges(assetId);
  });

  /* --- the fix reaches rows that are ALREADY stuck ------------------------- */

  await t.test('an asset already in this state comes right without a migration', async () => {
    /* The studio's own database has assets in this state right now. Settling at
       the source only helps work submitted from here on, so the read side has
       to forgive a row that is already wrong — which is why the held predicate
       is scoped to the current round as well.
       
       Arranged by putting the row back the way it was AFTER the submission,
       which is the state those assets are in. */
    const assetId = await pausedThenSubmitted('ana');
    assert.strictEqual((await requestChanges(assetId)).status, 200);
    await sql(cfg,
      `UPDATE work_sessions SET ended_reason = 'off_hours' WHERE asset_id = '${assetId}'`);

    const a = await onBoard(assetId, 'ana');
    assert.strictEqual(a.held, null,
      'a pause inside a round that has been handed in is not a live pause');
    assert.deepStrictEqual(buttons(a), { start: true, resume: false });
    assert.strictEqual((await as('ana', `/assets/${assetId}/start`, { method: 'POST' })).status, 200);
    await as('ana', `/assets/${assetId}/submit`, { method: 'POST', body: { link: 'https://example.com/v2' } });
  });

  /* --- what must NOT have changed ------------------------------------------ */

  await t.test('a pause inside the round somebody is still working IS still a pause', async () => {
    /* The other side of the fix, and the one a careless version breaks: the
       artist has not submitted, so the clock being down is exactly what the
       panel should say, and the schedule is what starts it again. */
    const assetId = await assignedAsset('ana');
    assert.strictEqual((await as('ana', `/assets/${assetId}/start`, { method: 'POST' })).status, 200);
    await sql(cfg,
      `UPDATE work_sessions SET ended_at = NOW(), seconds = 600, ended_reason = 'off_hours'
        WHERE asset_id = '${assetId}' AND ended_at IS NULL`);

    const a = await onBoard(assetId, 'ana');
    assert.ok(a.held, 'still paused — nothing has been handed in');
    assert.strictEqual(a.held.byStudio, true, 'and the schedule did it');
    assert.deepStrictEqual(buttons(a), { start: false, resume: false },
      'no Accept and Start on work already under way, and no Resume for the schedule\'s pause');

    // Submitting is what ends it, and then the pause is over.
    await as('ana', `/assets/${assetId}/submit`, { method: 'POST', body: { link: 'https://example.com/v1' } });
    assert.strictEqual((await onBoard(assetId, 'ana')).held, null);
  });

  await t.test('a hold somebody made keeps its Resume', async () => {
    /* Settling is about the round ENDING, so it must not touch a pause inside a
       round still under way — and a deliberate hold is the case where the
       button is the only way back. */
    const assetId = await assignedAsset('ana');
    assert.strictEqual((await as('ana', `/assets/${assetId}/start`, { method: 'POST' })).status, 200);
    assert.strictEqual((await as('ana', `/assets/${assetId}/hold`, {
      method: 'POST', body: { note: 'waiting on a brief' } })).status, 200);

    const a = await onBoard(assetId, 'ana');
    assert.strictEqual(a.held.byStudio, false, 'their hold, not the schedule\'s');
    assert.deepStrictEqual(buttons(a), { start: false, resume: true }, 'and Resume is there');
    assert.strictEqual((await as('ana', `/assets/${assetId}/resume`, { method: 'POST' })).status, 200);
    await as('ana', `/assets/${assetId}/submit`, { method: 'POST', body: { link: 'https://example.com/v1' } });
  });

  await t.test('the one-active-task rule still bites, and did not cause this', async () => {
    /* The studio's third step, and the second of the four causes they asked
       about. It was never the culprit — the API took POST /start throughout —
       but a fix that loosened it would be worse than the bug. */
    const first = await pausedThenSubmitted('ana');
    assert.strictEqual((await requestChanges(first)).status, 200);
    assert.strictEqual((await as('lead', `/assets/${first}/reassign`, {
      method: 'POST', body: { assigneeId: id.ana } })).status, 200);
    assert.strictEqual((await as('ana', `/assets/${first}/start`, { method: 'POST' })).status, 200,
      'the reassigned round starts');

    const second = await assignedAsset('ana');
    const blocked = await as('ana', `/assets/${second}/start`, { method: 'POST' });
    assert.strictEqual(blocked.status, 409, 'and a genuinely separate second task is refused');
    assert.match(blocked.body.error, /finish/i);

    await as('ana', `/assets/${first}/submit`, { method: 'POST', body: { link: 'https://example.com/v2' } });
    assert.strictEqual((await as('ana', `/assets/${second}/start`, { method: 'POST' })).status, 200,
      'and allowed once the first is handed in');
    await as('ana', `/assets/${second}/submit`, { method: 'POST', body: { link: 'https://example.com/v1' } });
  });

  await t.test('the reassigned round records its own hours, from nothing', async () => {
    /* The studio's fourth step. The previous round's hour stays on the asset's
       lifetime and on the closed episode; the new round starts at zero, which
       is what makes Time Spent mean "what the person holding it now has put
       in" rather than "what this asset has cost". */
    const assetId = await pausedThenSubmitted('ana');
    assert.strictEqual((await requestChanges(assetId)).status, 200);
    assert.strictEqual((await as('lead', `/assets/${assetId}/reassign`, {
      method: 'POST', body: { assigneeId: id.ana } })).status, 200);

    const before = await onBoard(assetId, 'ana');
    assert.strictEqual(before.round_seconds, 0, 'the new round starts at nothing');
    assert.strictEqual(before.time_spent_seconds, 3600, 'and the asset keeps what it cost');

    assert.strictEqual((await as('ana', `/assets/${assetId}/start`, { method: 'POST' })).status, 200);
    const running = await onBoard(assetId, 'ana');
    assert.strictEqual(running.work_open, true, 'the clock is running, not blocked by the old row');
    assert.strictEqual(running.held, null);
    await as('ana', `/assets/${assetId}/submit`, { method: 'POST', body: { link: 'https://example.com/v2' } });
  });

  await t.test('the ordinary flow, with no pause anywhere, is untouched', async () => {
    /* The studio's fifth step. Nothing above should have moved the path that
       was working: start, submit, changes, start again. */
    const assetId = await assignedAsset('ben');
    assert.strictEqual((await as('ben', `/assets/${assetId}/start`, { method: 'POST' })).status, 200);
    const sent = await as('ben', `/assets/${assetId}/submit`, {
      method: 'POST', body: { link: 'https://example.com/v1' } });
    assert.strictEqual(sent.status, 201, JSON.stringify(sent.body));
    const rows = await sessions(assetId);
    assert.strictEqual(rows[0].ended_reason, 'submitted', 'closed the way it always was');

    assert.strictEqual((await requestChanges(assetId)).status, 200);
    const a = await onBoard(assetId, 'ben');
    assert.strictEqual(a.held, null);
    assert.deepStrictEqual(buttons(a), { start: true, resume: false });
    assert.strictEqual((await as('ben', `/assets/${assetId}/start`, { method: 'POST' })).status, 200);
    await as('ben', `/assets/${assetId}/submit`, { method: 'POST', body: { link: 'https://example.com/v2' } });
  });
});
