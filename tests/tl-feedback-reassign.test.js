/* Routing work on from TL Feedbacks.
 *
 * WHAT WAS ASKED FOR, AND WHAT WAS ALREADY THERE. The studio asked for an
 * assign/reassign control on the TL Feedbacks stage, reusing the existing
 * reassignment rather than a path of its own. It reuses it because it already
 * IS it: tl_changes_requested is one of the four stages in the
 * 'reassign_review' transition's `from` list, and the panel has offered the
 * control there since the rework stages were moved onto that path.
 *
 * So this file is not new behaviour. It is the behaviour, pinned — every one of
 * the six things the studio asked to be able to check, asserted, so that a
 * feature nobody wrote on purpose cannot be removed by accident either.
 *
 * THE FOUR THINGS IT HOLDS:
 *
 *   The list is the studio's eligible-assignee list, so a Team Lead appears in
 *      it. That is the whole point of the recent assignability work reaching
 *      this screen too.
 *
 *   It leaves TL Feedbacks. Handing rework on returns it to Assigned with a
 *      fresh episode, rather than passing a half-finished round to somebody
 *      who has not seen it.
 *
 *   Both people are told: the one picking it up, and the one it left.
 *
 *   Only somebody who may review at that gate — or who owns the asset — sees
 *      it. Not everybody who can open the board.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const workflow = require('../src/asset-workflow');
const { config, resetSchema, startServer, stopServer, api, SKIP_REASON } = require('./helpers');

const cfg = config('tlfeedback');
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// --- the stage is on the hand-over path at all --------------------------------

test('TL Feedbacks is one of the stages work can be handed on from', () => {
  /* The single fact the whole feature rests on. If tl_changes_requested ever
     leaves this list, the control disappears from the screen and the endpoint
     starts refusing — silently, from the studio's point of view. */
  const from = workflow.transitionFor('reassign_review').from;
  assert.ok(from.includes('tl_changes_requested'), `TL Feedbacks is not on the hand-over path: ${from}`);
  assert.strictEqual(workflow.transitionFor('reassign_review').to, 'assigned',
    'and handing it on returns it to an active state');
});

test('the page offers the control on the same four stages the server allows', () => {
  const list = PAGE.match(/const HAND_OVER_STATUSES = \[([\s\S]*?)\];/);
  assert.ok(list, 'public/index.html has no HAND_OVER_STATUSES');
  const inPage = [...list[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepStrictEqual(inPage, [...workflow.transitionFor('reassign_review').from].sort(),
    'the screen and the workflow must agree about where this is offered');
});

test('the control is gated on reviewing at that stage, not on seeing the board', () => {
  const fn = PAGE.match(/function mayHandOverInReview\(a\)\{([\s\S]*?)\n\}/);
  assert.ok(fn);
  assert.match(fn[1], /a\.status === 'tl_changes_requested'\) return can\('review\.tl'\)/,
    'TL Feedbacks asks for the TL review permission');
  assert.match(fn[1], /if\(!can\('asset\.assign'\)\) return false;/,
    'and for the permission to assign at all');
});

// --- against a live server -----------------------------------------------------

test('reassigning out of TL Feedbacks', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'TlFeedback-1!';
  let server;
  const tok = {};
  const id = {};
  let projectId;

  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: tok[who] });
  const login = async (email) =>
    (await api(server.base, '/auth/login', { method: 'POST', body: { email, password: PASSWORD } })).body.token;
  const mark = async (who) => (await as(who, '/notifications/poll')).body.cursor;
  const since = async (who, c) => (await as(who, `/notifications/poll?since=${c}`)).body.fresh || [];
  const kinds = (l) => l.map((x) => x.kind);
  const fetchAsset = async (assetId) => {
    const r = await as('root', `/assets/project/${projectId}`);
    return r.body.assets.find((a) => a.id === assetId);
  };

  /* An asset driven all the way to TL Feedbacks: assigned, started, submitted,
     and sent back by the lead. Every step through its own route, so the state
     under test is one the application really produces. */
  let n = 0;
  const inTlFeedback = async () => {
    const made = await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: `Rework ${n += 1}`, type: 'prop' },
    });
    const asset = made.body.asset;
    await as('root', `/assets/${asset.id}`, { method: 'PATCH', body: { assigneeId: id.ana } });
    await as('ana', `/assets/${asset.id}/start`, { method: 'POST' });
    await as('ana', `/assets/${asset.id}/submit`, { method: 'POST', body: { link: 'https://example.com/v1' } });
    const sent = await as('lead', `/assets/${asset.id}/review`, {
      method: 'POST', body: { decision: 'changes_requested', text: 'tighten the silhouette' },
    });
    assert.ok(sent.status < 400, `review: ${JSON.stringify(sent.body)}`);
    const now = await fetchAsset(asset.id);
    assert.strictEqual(now.status, 'tl_changes_requested', 'setup');
    return now;
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'test-bootstrap-token' });
    await api(server.base, '/auth/bootstrap', {
      method: 'POST',
      body: { token: 'test-bootstrap-token', name: 'Root Admin', email: 'root@zvky.test', password: PASSWORD },
    });
    tok.root = await login('root@zvky.test');

    const make = async (key, name, email, role, teamLeadId) => {
      const r = await as('root', '/users', {
        method: 'POST', body: { name, email, role, password: PASSWORD, teamLeadId },
      });
      assert.strictEqual(r.status, 201, `${role}: ${JSON.stringify(r.body)}`);
      id[key] = r.body.user.id;
      tok[key] = await login(email);
    };
    await make('lead', 'Lena Lead', 'lead@zvky.test', 'team_lead');
    await make('other', 'Otto Lead', 'otto@zvky.test', 'team_lead');
    await make('ana', 'Ana Artist', 'ana@zvky.test', 'game_artist', id.lead);
    await make('bo', 'Bo Chen', 'bo@zvky.test', 'game_artist', id.lead);
    await make('percy', 'Percy Producer', 'percy@zvky.test', 'producer');

    const clients = await as('root', '/clients');
    const project = await as('root', '/projects', {
      method: 'POST',
      body: { name: 'Rework Road', clientId: clients.body.clients[0].id, teamLeadIds: [id.lead] },
    });
    assert.strictEqual(project.status, 201, JSON.stringify(project.body));
    projectId = project.body.project.id;
  });

  t.after(() => stopServer(server));

  /* --- 1: the control and its list ---------------------------------------- */

  await t.test('the reviewing lead is offered the studio\'s eligible-assignee list', async () => {
    const asset = await inTlFeedback();
    const r = await as('lead', `/assets/${asset.id}/reassign-options`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const roles = r.body.options.map((o) => o.role);
    assert.ok(roles.includes('team_lead'),
      'another Team Lead has to be pickable — the point of making leads assignable');
    assert.ok(roles.includes('game_artist'));
    assert.ok(!roles.includes('producer'), 'a designation that is never assigned work is not offered');
    assert.ok(!r.body.options.some((o) => o.id === id.ana),
      'nor whoever already holds it — the work is with them already');
  });

  /* --- 2 and 3: what a hand-over does -------------------------------------- */

  await t.test('handing it to somebody else moves it out of TL Feedbacks', async () => {
    const asset = await inTlFeedback();
    const outgoing = await mark('ana');
    const incoming = await mark('bo');

    const r = await as('lead', `/assets/${asset.id}/reassign`, {
      method: 'POST', body: { assigneeId: id.bo, note: 'Bo to pick this up' },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));

    const now = await fetchAsset(asset.id);
    assert.strictEqual(now.status, 'assigned', 'an active state, not a review queue');
    assert.strictEqual(now.assignee_id, id.bo, 'under the new person');

    assert.deepStrictEqual(kinds(await since('bo', incoming)), ['assigned'],
      'the new person is told, the same way any assignment tells them');
    assert.deepStrictEqual(kinds(await since('ana', outgoing)), ['unassigned'],
      'and the person it left is told, so they are not left wondering');
  });

  await t.test('handing it to another Team Lead works the same way', async () => {
    const asset = await inTlFeedback();
    const c = await mark('other');
    const r = await as('lead', `/assets/${asset.id}/reassign`, {
      method: 'POST', body: { assigneeId: id.other },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.strictEqual((await fetchAsset(asset.id)).assignee_id, id.other);
    assert.deepStrictEqual(kinds(await since('other', c)), ['assigned']);
  });

  await t.test('Reassign to Same User sends the rework back as a fresh round', async () => {
    /* WHAT THIS USED TO ASSERT, AND WHY IT CHANGED. It pinned a refusal:
       naming the current assignee was a 400, on the reasoning that in TL
       Feedbacks the work is already with them. True, but it made the ordinary
       case — rework going back to the person who did the first round — the one
       thing the screen would not do, and left the asset sitting in a feedback
       queue rather than back on the board as live work.
       
       The studio asked for it as a one-click action, and it is the same move
       the picker makes for anybody else: out of TL Feedbacks, into Assigned, a
       new episode, a new clock. */
    const asset = await inTlFeedback();
    const told = await mark('ana');

    const r = await as('lead', `/assets/${asset.id}/reassign`, {
      method: 'POST', body: { assigneeId: id.ana },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));

    const now = await fetchAsset(asset.id);
    assert.strictEqual(now.status, 'assigned', 'out of the feedback queue and back on the board');
    assert.strictEqual(now.assignee_id, id.ana, 'with the same person');

    /* ONE NOTIFICATION, NOT TWO CONTRADICTING EACH OTHER. They are being told
       the work is theirs again; they are emphatically not being told they lost
       it, because they did not. */
    const theirs = kinds(await since('ana', told));
    assert.deepStrictEqual(theirs, ['assigned'],
      `the same person must not be told both that they gained and lost it: ${theirs}`);

    // The history says what happened, in words a person reads.
    const h = await as('lead', `/assets/${asset.id}/history`);
    const last = h.body.events[h.body.events.length - 1];
    assert.strictEqual(last.action, 'reassign_review', 'the same action as any other hand-over');
    assert.strictEqual(last.fromStatus, 'tl_changes_requested');
    assert.strictEqual(last.toStatus, 'assigned');
    assert.match(last.note, /Sent back to Ana Artist/,
      'and not "Reassigned from Ana Artist to Ana Artist", which is true and unreadable');
  });

  await t.test('the quick path is on the screen, beside the full picker', async () => {
    /* Two controls, both offered on a rework stage: the one-click return to
       whoever holds it, and the picker for anybody else. The studio asked for
       both, and the quick one is first because it is the common case. */
    assert.match(PAGE, /id="reassignSameBtn"/, 'the one-click button exists');
    assert.match(PAGE, /Reassign to Same User/, 'labelled as the studio asked');
    assert.match(PAGE, /Reassign to Any User/, 'and the picker is labelled beside it');

    const wired = PAGE.match(/const sameBtn = document\.getElementById\('reassignSameBtn'\);([\s\S]*?)\n    \};/);
    assert.ok(wired, 'and it is wired');
    assert.match(wired[1], /\/reassign`/, 'to the same endpoint the picker uses');
    assert.ok(!/reassign-same|same-user/.test(PAGE),
      'no second endpoint was invented for it — same validation, same history, same notifications');
  });

  /* --- 4: who may do it ---------------------------------------------------- */

  await t.test('a contributor never sees the rework at all, let alone the control', async () => {
    /* Bo is an artist on the same project as Ana. A contributor's board is
       their own assignments and nothing else, so an asset sitting in Ana's TL
       Feedbacks is not on Bo's board, is not readable by Bo, and cannot offer
       Bo a control. Asserted in that order because "Bo did not see the button"
       would otherwise be ambiguous between the gate and the board. */
    const asset = await inTlFeedback();

    const board = await as('bo', `/assets/project/${projectId}`);
    assert.strictEqual(board.status, 200, 'Bo can open the project');
    assert.ok(!board.body.assets.some((a) => a.id === asset.id),
      'somebody else\'s work is not on a contributor\'s board');

    const picker = await as('bo', `/assets/${asset.id}/reassign-options`);
    assert.strictEqual(picker.status, 403, 'the picker refuses them');
    const doing = await as('bo', `/assets/${asset.id}/reassign`, {
      method: 'POST', body: { assigneeId: id.ana },
    });
    assert.ok(doing.status >= 400, 'and so does the hand-over itself');
  });

  await t.test('the person doing the rework cannot hand it on either', async () => {
    const asset = await inTlFeedback();
    const r = await as('ana', `/assets/${asset.id}/reassign-options`);
    assert.strictEqual(r.status, 403,
      'being the assignee is not being the reviewer');
  });

  await t.test('the gate is the TL review permission, not the designation', async () => {
    /* The studio asked for "Team Leads and whoever else currently has that
       review capability" — so the honest test is not "a Producer cannot" but
       "whoever holds review.tl can, and the moment Settings takes it away they
       cannot". Percy is put on the project as a coordinator first, because a
       Producer who cannot reach the project would be refused by the board and
       prove nothing about the gate.

       Out of the box Production holds review.tl, so a Producer who can see the
       asset SHOULD get this control. That is the feature working as specified,
       not a leak. */
    const joined = await as('root', `/projects/${projectId}`, {
      method: 'PATCH', body: { coordinatorIds: [id.percy] },
    });
    assert.ok(joined.status < 400, `putting the Producer on the project: ${JSON.stringify(joined.body)}`);

    const held = await as('root', '/permissions/roles/producer');
    assert.strictEqual(held.status, 200, JSON.stringify(held.body));
    const enabled = held.body.role.permissions.filter((p) => p.enabled).map((p) => p.key);
    assert.ok(enabled.includes('review.tl'),
      'Production holds TL review out of the box — if that default changes, so does this test');

    const asset = await inTlFeedback();
    const withIt = await as('percy', `/assets/${asset.id}/reassign-options`);
    assert.strictEqual(withIt.status, 200,
      `holding review.tl, the Producer is offered the list: ${JSON.stringify(withIt.body)}`);

    /* Now take it away in Settings — the same screen a Super Admin uses — and
       nothing else. Same person, same project, same asset. */
    const off = await as('root', '/permissions/roles/producer', {
      method: 'PUT', body: { permissions: enabled.filter((k) => k !== 'review.tl') },
    });
    assert.strictEqual(off.status, 200, JSON.stringify(off.body));
    try {
      const without = await as('percy', `/assets/${asset.id}/reassign-options`);
      assert.strictEqual(without.status, 403,
        'with review.tl switched off the picker refuses them');
      const doing = await as('percy', `/assets/${asset.id}/reassign`, {
        method: 'POST', body: { assigneeId: id.bo },
      });
      assert.ok(doing.status >= 400, 'and so does the hand-over itself');
      assert.strictEqual((await fetchAsset(asset.id)).status, 'tl_changes_requested',
        'and the asset has not moved');
    } finally {
      /* Put it back, so a later subtest is not reading a studio this one
         reconfigured. */
      const back = await as('root', '/permissions/roles/producer', {
        method: 'PUT', body: { permissions: enabled },
      });
      assert.strictEqual(back.status, 200, JSON.stringify(back.body));
    }

    const again = await as('percy', `/assets/${asset.id}/reassign-options`);
    assert.strictEqual(again.status, 200, 'and switching it back on restores the control');
  });

  /* --- 5: the guards that must still apply --------------------------------- */

  await t.test('a designation that is not assigned work is still refused', async () => {
    const asset = await inTlFeedback();
    const r = await as('lead', `/assets/${asset.id}/reassign`, {
      method: 'POST', body: { assigneeId: id.percy },
    });
    assert.ok(r.status >= 400, 'a Producer cannot be handed the work');
    assert.match(JSON.stringify(r.body), /not assigned work|not in this studio|cannot/i);
  });

  await t.test('a lead may take it themselves, and then cannot review their own work', async () => {
    /* The self-review guard, reached through this entry point. Taking the work
       is allowed — leads are assignable — and what is not allowed is then
       approving it. */
    const asset = await inTlFeedback();
    const taken = await as('lead', `/assets/${asset.id}/reassign`, {
      method: 'POST', body: { assigneeId: id.lead },
    });
    assert.strictEqual(taken.status, 200, JSON.stringify(taken.body));
    assert.strictEqual((await fetchAsset(asset.id)).assignee_id, id.lead);

    await as('lead', `/assets/${asset.id}/start`, { method: 'POST' });
    const submitted = await as('lead', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.com/mine' },
    });
    assert.strictEqual(submitted.status, 201, JSON.stringify(submitted.body));
    const selfReview = await as('lead', `/assets/${asset.id}/review`, {
      method: 'POST', body: { decision: 'approved' },
    });
    assert.ok(selfReview.status >= 400,
      `a lead approved their own submission (${selfReview.status}) — the guard is gone`);
  });

  await t.test('the single-active-task rule still bites', async () => {
    /* Somebody handed a second piece of work cannot start it while their first
       is open. The rule lives in the start route and is reached the same way
       whatever put the asset on their desk. */
    const first = await inTlFeedback();
    await as('lead', `/assets/${first.id}/reassign`, { method: 'POST', body: { assigneeId: id.bo } });
    const started = await as('bo', `/assets/${first.id}/start`, { method: 'POST' });
    assert.strictEqual(started.status, 200, JSON.stringify(started.body));

    const second = await inTlFeedback();
    await as('lead', `/assets/${second.id}/reassign`, { method: 'POST', body: { assigneeId: id.bo } });
    const blocked = await as('bo', `/assets/${second.id}/start`, { method: 'POST' });
    assert.strictEqual(blocked.status, 409, JSON.stringify(blocked.body));
    assert.match(JSON.stringify(blocked.body), /already|finish|active/i,
      'and it names what is holding them up');
  });

  /* --- 6: the record ------------------------------------------------------- */

  await t.test('the hand-over is in the asset\'s history, with the stage it left', async () => {
    const asset = await inTlFeedback();
    await as('lead', `/assets/${asset.id}/reassign`, {
      method: 'POST', body: { assigneeId: id.bo, note: 'Bo has the reference' },
    });
    const h = await as('lead', `/assets/${asset.id}/history`);
    assert.strictEqual(h.status, 200);
    const last = h.body.events[h.body.events.length - 1];
    assert.strictEqual(last.action, 'reassign_review');
    assert.strictEqual(last.fromStatus, 'tl_changes_requested', 'the stage it came from');
    assert.strictEqual(last.toStatus, 'assigned', 'and the one it went to');
    assert.match(last.note, /Ana Artist/, 'who it left');
    assert.match(last.note, /Bo Chen/, 'who has it now');
    assert.match(last.note, /TL Feedbacks/, 'and the stage, in words');
    assert.strictEqual(last.actor, 'Lena Lead', 'and who did it');
  });

  await t.test('and in the studio activity log', async () => {
    const asset = await inTlFeedback();
    await as('lead', `/assets/${asset.id}/reassign`, { method: 'POST', body: { assigneeId: id.bo } });
    const log = await as('root', '/activity?limit=25');
    assert.strictEqual(log.status, 200, JSON.stringify(log.body));
    const rows = log.body.entries || log.body.activity || log.body.rows || [];
    const hit = rows.find((e) => /reassign_review/.test(e.action || ''));
    assert.ok(hit, `no reassignment in the log: ${rows.slice(0, 4).map((e) => e.action).join(', ')}`);
    assert.match(hit.summary || '', /tl_changes_requested|assigned/,
      'recording the stage it moved between');
  });
});
