const test = require('node:test');
const assert = require('node:assert');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');
const workflow = require('../src/asset-workflow');
const submissionLink = require('../src/submission-link');

const cfg = config('workflow');

// --- the machine, on its own --------------------------------------------------

test('the eight states match the dashboard, in pipeline order', () => {
  assert.deepStrictEqual(workflow.STATES.map((s) => s.id), [
    'not_started', 'in_progress', 'pending_tl_review', 'tl_changes_requested',
    'pending_cd_review', 'cd_changes_requested', 'approved_for_client', 'delivered',
  ]);
  assert.deepStrictEqual(workflow.STATES.map((s) => s.label), [
    'Not Started', 'In Progress', 'TL Review', 'TL Changes',
    'CD Review', 'CD Changes', 'Approved for Client', 'Delivered',
  ]);
});

test('a move not in the table cannot happen', () => {
  // The point of a table rather than a pile of if-statements: anything absent
  // is refused, rather than falling through to whatever the last branch did.
  const ctx = {
    user: { id: 'u1', role: 'game_artist' },
    asset: { assignee_id: 'u1', routed_to_id: null, status: 'delivered' },
    isTeamLead: false, canOverride: false, canEdit: true, canDeliver: true,
  };
  const done = workflow.evaluate('submit', ctx);
  assert.strictEqual(done.ok, false);
  assert.strictEqual(done.status, 409, 'a legal action from an illegal state is a conflict');
  assert.match(done.error, /Delivered/);

  const nonsense = workflow.evaluate('teleport', ctx);
  assert.strictEqual(nonsense.ok, false);
  assert.strictEqual(nonsense.status, 400, 'an action that does not exist is a bad request');
});

test('CD Changes is not the assignee\'s until the lead passes it on', () => {
  // The distinction the relay rests on: routed to nobody means "in a review
  // queue", which for this state is the lead — not "free for anyone".
  const base = {
    user: { id: 'artist', role: 'game_artist' },
    isTeamLead: false, canOverride: false, canEdit: false, canDeliver: false,
  };
  const unrelayed = workflow.evaluate('submit', {
    ...base, asset: { assignee_id: 'artist', routed_to_id: null, status: 'cd_changes_requested' },
  });
  assert.strictEqual(unrelayed.ok, false);
  assert.strictEqual(unrelayed.status, 403);
  assert.match(unrelayed.error, /has not passed the Creative Director/i);

  const relayed = workflow.evaluate('submit', {
    ...base, asset: { assignee_id: 'artist', routed_to_id: 'artist', status: 'cd_changes_requested' },
  });
  assert.strictEqual(relayed.ok, true);

  // An unrouted asset in one of the assignee's own states is still theirs, so
  // rows written before routing existed keep working.
  const legacy = workflow.evaluate('submit', {
    ...base, asset: { assignee_id: 'artist', routed_to_id: null, status: 'tl_changes_requested' },
  });
  assert.strictEqual(legacy.ok, true);
});

test('where a CD-changes resubmission lands is configurable', () => {
  const saved = process.env.CD_CHANGES_REENTRY;
  const ctx = {
    user: { id: 'artist', role: 'game_artist' },
    asset: { assignee_id: 'artist', routed_to_id: 'artist', status: 'cd_changes_requested' },
    isTeamLead: false, canOverride: false, canEdit: false, canDeliver: false,
  };
  try {
    delete process.env.CD_CHANGES_REENTRY;
    assert.strictEqual(workflow.cdChangesReentry(), 'tl', 'the lead re-checks by default');
    assert.strictEqual(workflow.evaluate('submit', ctx).to, 'pending_tl_review');

    process.env.CD_CHANGES_REENTRY = 'cd';
    assert.strictEqual(workflow.evaluate('submit', ctx).to, 'pending_cd_review', 'flipped by one variable');

    process.env.CD_CHANGES_REENTRY = 'nonsense';
    assert.strictEqual(workflow.evaluate('submit', ctx).to, 'pending_tl_review', 'anything unrecognised is the default');
  } finally {
    if (saved === undefined) delete process.env.CD_CHANGES_REENTRY;
    else process.env.CD_CHANGES_REENTRY = saved;
  }
});

test('requesting changes without saying what needs to change is refused', () => {
  const ctx = {
    user: { id: 'tl', role: 'team_lead' },
    asset: { assignee_id: 'artist', routed_to_id: null, status: 'pending_tl_review' },
    isTeamLead: true, canOverride: false, canEdit: true, canDeliver: false,
  };
  assert.strictEqual(workflow.evaluate('tl_request_changes', ctx, { note: '   ' }).ok, false);
  assert.strictEqual(workflow.evaluate('tl_request_changes', ctx, { note: 'Fix the silhouette' }).ok, true);
  // Approving needs no note.
  assert.strictEqual(workflow.evaluate('tl_approve', ctx).ok, true);
});

// --- link validation ----------------------------------------------------------

test('a submission link may point inside the building', () => {
  // The common case in a studio: a host with no dot in it, or an IP and a port.
  for (const link of [
    'https://drive.example.com/shot-01',
    'http://nas/shots/ep01',
    'http://192.168.1.20:8080/renders/v3',
    'http://localhost:3000/preview',
    'https://review.example.com/a?v=2#note',
    'smb://fileserver/projects/hero.psd',
    'file:///mnt/renders/hero.exr',
  ]) {
    assert.strictEqual(submissionLink.validate(link).ok, true, `${link} should be accepted`);
  }
});

test('anything that is not a link is refused, with an example', () => {
  for (const bad of ['', '   ', 'not a url', 'drive.example.com/shot', '/just/a/path', 'shot-01.psd']) {
    const verdict = submissionLink.validate(bad);
    assert.strictEqual(verdict.ok, false, `"${bad}" should be refused`);
    assert.ok(verdict.error);
  }
  // A link is opened by whoever reviews it, so a script URL is not a link.
  assert.strictEqual(submissionLink.validate('javascript:alert(1)').ok, false);
  assert.strictEqual(submissionLink.validate('data:text/html,<script>alert(1)</script>').ok, false);
  assert.match(submissionLink.validate('not a url').error, /https:\/\/|http:\/\//, 'the message shows what one looks like');
});

// --- the pipeline, against a live server --------------------------------------

test('the review pipeline', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Workflow-Test-1!';
  let server;
  const token = {};
  let projectId;
  const people = {};

  const call = (path, options) => api(server.base, path, options);
  const act = (id, action, who, body) =>
    call(`/assets/${id}/${action}`, { token: token[who], method: 'POST', body: body || {} });
  const statusOf = async (id) =>
    (await call(`/assets/${id}/history`, { token: token.admin })).body.status;
  const historyOf = async (id) =>
    (await call(`/assets/${id}/history`, { token: token.admin })).body.events;

  async function newAsset(name, { assign = true } = {}) {
    const res = await call(`/assets/project/${projectId}`, {
      token: token.admin, method: 'POST',
      body: { name, type: 'character', ...(assign ? { assigneeId: people.artist } : {}) },
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body.asset.id;
  }

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'workflow-token' });
    await call('/auth/bootstrap', {
      method: 'POST',
      body: { token: 'workflow-token', name: 'Studio Admin', email: 'admin@zvky.test', password: PASSWORD },
    });
    const login = async (email) => (await call('/auth/login', {
      method: 'POST', body: { email, password: PASSWORD },
    })).body.token;
    token.admin = await login('admin@zvky.test');

    projectId = (await call('/projects', { token: token.admin, method: 'POST', body: { name: 'Skyfall' } })).body.project.id;

    const make = async (name, email, role, teamLeadId) => {
      const res = await call('/users', {
        token: token.admin, method: 'POST',
        body: { name, email, role, password: PASSWORD, projectId, ...(teamLeadId ? { teamLeadId } : {}) },
      });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      return res.body.user.id;
    };
    people.lead = await make('Priya Menon', 'tl@zvky.test', 'team_lead');
    people.cd = await make('Asha Rao', 'cd@zvky.test', 'art_director');
    people.artist = await make('Sam Iyer', 'art@zvky.test', 'game_artist', people.lead);
    people.other = await make('Dev Kumar', 'art2@zvky.test', 'game_artist', people.lead);

    token.lead = await login('tl@zvky.test');
    token.cd = await login('cd@zvky.test');
    token.artist = await login('art@zvky.test');
    token.other = await login('art2@zvky.test');
  });

  t.after(() => stopServer(server));

  await t.test('an asset starts Not Started, and assigning it starts the work', async () => {
    const id = await newAsset('Unassigned Prop', { assign: false });
    assert.strictEqual(await statusOf(id), 'not_started');

    const assigned = await call(`/assets/${id}`, {
      token: token.admin, method: 'PATCH', body: { assigneeId: people.artist },
    });
    assert.strictEqual(assigned.status, 200);
    assert.strictEqual(assigned.body.asset.status, 'in_progress', 'no separate "start" action');

    const events = await historyOf(id);
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].action, 'assign');
    assert.strictEqual(events[0].fromStatus, 'not_started');
    assert.strictEqual(events[0].toStatus, 'in_progress');
  });

  await t.test('the happy path runs end to end', async () => {
    const id = await newAsset('Hero Character');
    assert.strictEqual(await statusOf(id), 'in_progress', 'created with an assignee starts in progress');

    assert.strictEqual((await act(id, 'submit', 'artist',
      { link: 'http://nas/shots/hero-v1', description: 'First pass.' })).status, 201);
    assert.strictEqual(await statusOf(id), 'pending_tl_review');

    assert.strictEqual((await act(id, 'review', 'lead', { decision: 'approved' })).status, 200);
    assert.strictEqual(await statusOf(id), 'pending_cd_review');

    assert.strictEqual((await act(id, 'review', 'cd', { decision: 'approved' })).status, 200);
    assert.strictEqual(await statusOf(id), 'approved_for_client');

    assert.strictEqual((await act(id, 'deliver', 'admin')).status, 200);
    assert.strictEqual(await statusOf(id), 'delivered');

    assert.deepStrictEqual((await historyOf(id)).map((e) => e.action),
      ['assign', 'submit', 'tl_approve', 'cd_approve', 'deliver']);
  });

  await t.test('a TL-changes round goes back to the assignee and keeps both submissions', async () => {
    const id = await newAsset('Villain Character');
    await act(id, 'submit', 'artist', { link: 'https://review.example.com/v1' });

    const rejected = await act(id, 'review', 'lead',
      { decision: 'changes_requested', text: 'Silhouette reads flat.' });
    assert.strictEqual(rejected.status, 200);
    assert.strictEqual(rejected.body.asset.status, 'tl_changes_requested');
    assert.strictEqual(rejected.body.asset.routed_to_id, people.artist, 'routed back to the assignee');

    await act(id, 'submit', 'artist', { link: 'https://review.example.com/v2', description: 'Reworked.' });
    assert.strictEqual(await statusOf(id), 'pending_tl_review');

    // Both rounds are kept — a resubmission adds, it does not overwrite.
    const versions = await sql(cfg, `SELECT version_number, link, description FROM asset_versions WHERE asset_id = '${id}' ORDER BY version_number`);
    assert.strictEqual(versions.length, 2);
    assert.strictEqual(versions[0].link, 'https://review.example.com/v1');
    assert.strictEqual(versions[1].link, 'https://review.example.com/v2');
    assert.strictEqual(versions[1].description, 'Reworked.');

    const events = await historyOf(id);
    assert.deepStrictEqual(events.map((e) => e.action),
      ['assign', 'submit', 'tl_request_changes', 'submit']);
    assert.strictEqual(events[2].note, 'Silhouette reads flat.', 'the feedback is in the trail');
  });

  await t.test('a CD-changes round goes to the lead, who relays it', async () => {
    const id = await newAsset('Sidekick');
    await act(id, 'submit', 'artist', { link: 'https://review.example.com/s1' });
    await act(id, 'review', 'lead', { decision: 'approved' });

    const rejected = await act(id, 'review', 'cd',
      { decision: 'changes_requested', text: 'Palette is off-brief.' });
    assert.strictEqual(rejected.body.asset.status, 'cd_changes_requested');
    assert.strictEqual(rejected.body.asset.routed_to_id, null, 'with the lead, not the artist');

    // The artist cannot pick it up before the lead has briefed them.
    const early = await act(id, 'submit', 'artist', { link: 'https://review.example.com/s2' });
    assert.strictEqual(early.status, 403);
    assert.match(early.body.error, /team lead has not passed/i);

    const relayed = await act(id, 'relay', 'lead', { text: 'Cooler palette please.' });
    assert.strictEqual(relayed.status, 200);
    assert.strictEqual(relayed.body.asset.status, 'cd_changes_requested', 'the relay does not move the status');
    assert.strictEqual(relayed.body.asset.routed_to_id, people.artist, 'only whose desk it is on');

    // Default re-entry is the lead, who relayed it.
    const resubmitted = await act(id, 'submit', 'artist',
      { link: 'https://review.example.com/s2', description: 'Cooled it.' });
    assert.strictEqual(resubmitted.status, 201);
    assert.strictEqual(await statusOf(id), 'pending_tl_review');

    assert.deepStrictEqual((await historyOf(id)).map((e) => e.action),
      ['assign', 'submit', 'tl_approve', 'cd_request_changes', 'relay', 'submit']);
  });

  await t.test('permission is enforced at every gate, by the API', async () => {
    const id = await newAsset('Guarded Prop');
    // Only the assignee submits.
    const wrongArtist = await act(id, 'submit', 'other', { link: 'https://review.example.com/x' });
    assert.strictEqual(wrongArtist.status, 403);
    assert.match(wrongArtist.body.error, /assigned/i);

    await act(id, 'submit', 'artist', { link: 'https://review.example.com/g1' });

    // Not the artist, and not the CD, at the TL gate.
    for (const who of ['artist', 'cd']) {
      const res = await act(id, 'review', who, { decision: 'approved' });
      assert.strictEqual(res.status, 403, `${who} must not approve at TL Review`);
      assert.match(res.body.error, /team lead/i);
    }
    assert.strictEqual((await act(id, 'review', 'lead', { decision: 'approved' })).status, 200);

    // Not the lead, and not the artist, at the CD gate.
    for (const who of ['lead', 'artist']) {
      const res = await act(id, 'review', who, { decision: 'approved' });
      assert.strictEqual(res.status, 403, `${who} must not approve at CD Review`);
      assert.match(res.body.error, /Creative Director/i);
    }
    assert.strictEqual((await act(id, 'review', 'cd', { decision: 'approved' })).status, 200);

    // Only someone who may deliver.
    const artistDelivers = await act(id, 'deliver', 'artist');
    assert.strictEqual(artistDelivers.status, 403);
    assert.strictEqual((await act(id, 'deliver', 'admin')).status, 200);
  });

  await t.test('a submission without a valid link is refused', async () => {
    const id = await newAsset('Linkless');
    for (const body of [{}, { link: '' }, { link: 'not a url' }, { description: 'notes only' }]) {
      const res = await act(id, 'submit', 'artist', body);
      assert.strictEqual(res.status, 400, `${JSON.stringify(body)} should be refused`);
      assert.strictEqual(res.body.field, 'link');
    }
    assert.strictEqual(await statusOf(id), 'in_progress', 'and nothing moved');

    // A local link is fine, and the description really is optional.
    const ok = await act(id, 'submit', 'artist', { link: 'http://nas/shots/x' });
    assert.strictEqual(ok.status, 201);
  });

  await t.test('the history is in the order things happened', async () => {
    // A review round is quicker than one second, so ordering cannot come from
    // the timestamp — it comes from an append-only sequence.
    const id = await newAsset('Fast Round');
    await act(id, 'submit', 'artist', { link: 'http://nas/a' });
    await act(id, 'review', 'lead', { decision: 'changes_requested', text: 'again' });
    await act(id, 'submit', 'artist', { link: 'http://nas/b' });
    await act(id, 'review', 'lead', { decision: 'approved' });
    await act(id, 'review', 'cd', { decision: 'approved' });

    const events = await historyOf(id);
    assert.deepStrictEqual(events.map((e) => e.action),
      ['assign', 'submit', 'tl_request_changes', 'submit', 'tl_approve', 'cd_approve']);
    // Each event says where it came from and where it went.
    assert.deepStrictEqual(events.map((e) => e.toStatus), [
      'in_progress', 'pending_tl_review', 'tl_changes_requested',
      'pending_tl_review', 'pending_cd_review', 'approved_for_client',
    ]);
    for (let i = 1; i < events.length; i++) {
      assert.strictEqual(events[i].fromStatus, events[i - 1].toStatus, 'the chain has no gaps');
    }
  });

  await t.test('the pipeline cannot be bypassed without the override permission', async () => {
    // The caller has to be somebody who may edit this asset, or the refusal
    // would be about ownership rather than about the pipeline. The lead adds
    // their own asset: they own it, they hold asset.edit, and they hold no
    // override.
    const own = await call(`/assets/project/${projectId}`, {
      token: token.lead, method: 'POST',
      body: { name: 'Shortcut Attempt', type: 'character', assigneeId: people.artist },
    });
    assert.strictEqual(own.status, 201, JSON.stringify(own.body));
    const id = own.body.asset.id;

    const res = await call(`/assets/${id}`, {
      token: token.lead, method: 'PATCH', body: { status: 'delivered' },
    });
    assert.strictEqual(res.status, 409);
    assert.match(res.body.error, /submit\/review\/deliver/);
    assert.strictEqual(await statusOf(id), 'in_progress');

    // And somebody who did not add it is refused one step earlier, on
    // ownership, whatever the status they asked for.
    const notTheirs = await newAsset('Someone Else\'s');
    const outsider = await call(`/assets/${notTheirs}`, {
      token: token.lead, method: 'PATCH', body: { status: 'delivered' },
    });
    assert.strictEqual(outsider.status, 403);
    assert.strictEqual(await statusOf(notTheirs), 'in_progress');
  });

  await t.test('an override is allowed for whoever holds it, and is recorded', async () => {
    // asset.override_stage exists so a studio-wide administrator can unstick a
    // pipeline. The move is deliberately logged, so a status that skipped the
    // review flow is not a mystery afterwards.
    const id = await newAsset('Forced Through');
    const res = await call(`/assets/${id}`, {
      token: token.admin, method: 'PATCH', body: { status: 'delivered' },
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(await statusOf(id), 'delivered');

    const events = await historyOf(id);
    const forced = events.find((e) => e.action === 'override');
    assert.ok(forced, 'the override should appear in the history');
    assert.strictEqual(forced.fromStatus, 'in_progress');
    assert.strictEqual(forced.toStatus, 'delivered');
    assert.match(forced.note, /outside the review flow/i);

    // A status that is not a status is still refused.
    const nonsense = await call(`/assets/${await newAsset('Nonsense')}`, {
      token: token.admin, method: 'PATCH', body: { status: 'teleported' },
    });
    assert.strictEqual(nonsense.status, 400);
    assert.strictEqual(nonsense.body.field, 'status');
  });
});
