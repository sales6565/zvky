const test = require('node:test');
const assert = require('node:assert');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON, systemClientId } = require('./helpers');
const workflow = require('../src/asset-workflow');
const submissionLink = require('../src/submission-link');

const cfg = config('workflow');

// --- the machine, on its own --------------------------------------------------

test('the nine states match the dashboard, in pipeline order', () => {
  assert.deepStrictEqual(workflow.STATES.map((s) => s.id), [
    'not_started', 'assigned', 'in_progress', 'pending_tl_review', 'tl_changes_requested',
    'pending_cd_review', 'cd_changes_requested', 'approved_for_client', 'delivered',
  ]);
  assert.deepStrictEqual(workflow.STATES.map((s) => s.label), [
    'Not Assigned', 'Assigned', 'In Progress', 'TL Review', 'TL Changes',
    'CD Review', 'CD Changes', 'Approved for Client', 'Delivered',
  ]);
});

// The dashboard draws its columns and its stats bar from its own copy of the
// state list, and its drag handler from its own copy of the free range. Both
// copies have silently drifted from this module before — once when 'assigned'
// was added, which left the Assigned column unable to accept a dragged card and
// gave it a heading the backend never used the same words for. Check them.
test('the dashboard is drawn from the same states and the same free range', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  const block = page.match(/const STATUSES = \[([\s\S]*?)\];/);
  assert.ok(block, 'public/index.html has no STATUSES array');
  const drawn = [...block[1].matchAll(/\{id:'([a-z_]+)', label:'([^']+)'/g)]
    .map((m) => ({ id: m[1], label: m[2] }));
  assert.deepStrictEqual(
    drawn,
    workflow.STATES.map((s) => ({ id: s.id, label: s.label })),
    'the dashboard columns and the workflow states have drifted apart'
  );

  // The tile and the column must come from one list. They are rendered in two
  // places, and the last time those two places each kept their own copy of a
  // status list they drifted — which is how the Assigned column became one no
  // card could be dragged into.
  const gated = 'visibleStatuses()';
  for (const site of ['`<div class="board">${' + gated, '    ' + gated + '.map(s=>{ const c=pool.filter']) {
    assert.ok(page.includes(site),
      `the dashboard should draw its columns and its stat tiles from ${gated} — missing: ${site}`);
  }
  assert.match(page, /function visibleStatuses\(\)\{\s*\n\s*if\(can\('asset\.add'\)\) return STATUSES;/,
    "visibleStatuses should gate on can('asset.add'), the same way every other gate on the page does");

  // The stages hidden from an account that cannot add assets. Every one of them
  // must be a real state id — a typo here would hide nothing and say nothing.
  const planner = page.match(/const PLANNER_STATUSES = \[([^\]]*)\]/);
  assert.ok(planner, 'the hidden stages should be one named list');
  const hidden = planner[1].split(',').map((v) => v.trim().replace(/'/g, '')).filter(Boolean);
  assert.deepStrictEqual(hidden, ['not_started', 'pending_cd_review', 'cd_changes_requested']);
  for (const id of hidden) {
    assert.ok(workflow.STATE_IDS.includes(id), `"${id}" is not a status the pipeline has`);
  }

  const free = page.match(/const FREE = \[([^\]]*)\]/);
  assert.ok(free, 'the dashboard drag handler has no FREE list');
  assert.deepStrictEqual(
    free[1].split(',').map((v) => v.trim().replace(/'/g, '')),
    workflow.FREE_STATUSES,
    'the dashboard drag range and FREE_STATUSES have drifted apart'
  );
});

test('assigning is allowed by asset.assign OR asset.edit, not by asset.edit alone', () => {
  // The actor behind the assign transition is "anyone who may set up work on
  // this asset". It read canEdit alone, so a role holding asset.assign without
  // asset.edit could not perform the one transition its permission names.
  const base = {
    user: { id: 'u1', role: 'producer' },
    asset: { assignee_id: 'u2', routed_to_id: null, status: 'not_started' },
    isTeamLead: false, canOverride: false, canDeliver: false,
    canReviewCd: false, canApproveForClient: false,
  };
  assert.ok(workflow.evaluate('assign', { ...base, canAssign: true, canEdit: false }).ok,
    'asset.assign alone is enough to assign');
  assert.ok(workflow.evaluate('assign', { ...base, canAssign: false, canEdit: true }).ok,
    'asset.edit alone still is too');
  assert.ok(!workflow.evaluate('assign', { ...base, canAssign: false, canEdit: false }).ok,
    'neither is not');
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

    const clientId = await systemClientId(server.base, token.admin);
    projectId = (await call('/projects', { token: token.admin, method: 'POST', body: { clientId, name: 'Skyfall' } })).body.project.id;

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

  await t.test('assigning parks the asset in Assigned; accepting starts it', async () => {
    // The old rule — assignment moves work straight to In Progress — is
    // superseded: the assignee picking it up is its own act, and it is the
    // moment the clock starts.
    const id = await newAsset('Unassigned Prop', { assign: false });
    assert.strictEqual(await statusOf(id), 'not_started');

    const assigned = await call(`/assets/${id}`, {
      token: token.admin, method: 'PATCH', body: { assigneeId: people.artist },
    });
    assert.strictEqual(assigned.status, 200);
    assert.strictEqual(assigned.body.asset.status, 'assigned', 'not Not Assigned, not In Progress');

    const accepted = await call(`/assets/${id}/timer/start`, { token: token.artist, method: 'POST' });
    assert.strictEqual(accepted.status, 200, JSON.stringify(accepted.body));
    assert.strictEqual(accepted.body.accepted, true);
    assert.strictEqual(accepted.body.asset.status, 'in_progress');
    assert.strictEqual(accepted.body.timer.running, true, 'and the clock is running');
    await call(`/assets/${id}/timer/pause`, { token: token.artist, method: 'POST' });

    const events = await historyOf(id);
    assert.deepStrictEqual(events.map((e) => e.action), ['assign', 'accept']);
    assert.deepStrictEqual(events.map((e) => e.toStatus), ['assigned', 'in_progress']);
  });

  await t.test('the happy path runs end to end', async () => {
    const id = await newAsset('Hero Character');
    assert.strictEqual(await statusOf(id), 'assigned', 'created with an assignee waits to be accepted');

    assert.strictEqual((await call(`/assets/${id}/timer/start`, { token: token.artist, method: 'POST' })).status, 200);
    assert.strictEqual(await statusOf(id), 'in_progress');
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
      ['assign', 'accept', 'submit', 'tl_approve', 'cd_approve', 'deliver']);
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

  await t.test('assigning needs asset.assign, not asset.edit', async () => {
    // The bug this covers, in the shape it actually took: a role that can add
    // and assign assets but not edit them. Creating an asset with an assignee
    // wrote the assignee in the INSERT and then silently skipped the assign
    // transition, because the transition asked whether the actor could *edit*.
    // The asset came back assigned to somebody and still reading not_started —
    // an avatar sitting in the Not Assigned column.
    const enabled = async (role) =>
      (await call(`/permissions/roles/${role}`, { token: token.admin }))
        .body.role.permissions.filter((p) => p.enabled).map((p) => p.key);

    const before = await enabled('producer');
    assert.ok(before.includes('asset.add') && before.includes('asset.assign'),
      'the fixture role should start with both');
    const put = await call('/permissions/roles/producer', {
      token: token.admin, method: 'PUT',
      body: { confirm: true, permissions: before.filter((k) => k !== 'asset.edit') },
    });
    assert.strictEqual(put.status, 200, JSON.stringify(put.body));

    try {
      const res = await call('/users', {
        token: token.admin, method: 'POST',
        body: { name: 'Noel Edit', email: 'noedit@zvky.test', role: 'producer',
                password: PASSWORD, projectId },
      });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      const noEdit = (await call('/auth/login', {
        method: 'POST', body: { email: 'noedit@zvky.test', password: PASSWORD },
      })).body.token;

      // Created with an assignee.
      const created = await call(`/assets/project/${projectId}`, {
        token: noEdit, method: 'POST',
        body: { name: 'Assigned On Creation', type: 'character', assigneeId: people.artist },
      });
      assert.strictEqual(created.status, 201, JSON.stringify(created.body));
      const [rowA] = await sql(cfg,
        `SELECT \`status\`, assignee_id FROM assets WHERE id = '${created.body.asset.id}'`);
      assert.ok(rowA.assignee_id, 'the assignee was written');
      assert.strictEqual(rowA.status, 'assigned',
        'assigned in the database, not just in the response');

      // And assigned afterwards, which used to be refused outright.
      const bare = await call(`/assets/project/${projectId}`, {
        token: noEdit, method: 'POST', body: { name: 'Assigned Later', type: 'character' },
      });
      const patched = await call(`/assets/${bare.body.asset.id}`, {
        token: noEdit, method: 'PATCH', body: { assigneeId: people.artist },
      });
      assert.strictEqual(patched.status, 200,
        `asset.assign should be enough to assign — got ${JSON.stringify(patched.body)}`);
      const [rowB] = await sql(cfg,
        `SELECT \`status\`, assignee_id FROM assets WHERE id = '${bare.body.asset.id}'`);
      assert.strictEqual(rowB.status, 'assigned');

      // But it is still not permission to edit the record.
      const edited = await call(`/assets/${bare.body.asset.id}`, {
        token: noEdit, method: 'PATCH', body: { priority: 'high' },
      });
      assert.strictEqual(edited.status, 403, 'asset.assign is not asset.edit');
    } finally {
      await call('/permissions/roles/producer', {
        token: token.admin, method: 'PUT', body: { confirm: true, permissions: before },
      });
    }
  });

  await t.test('a failure after the write does not report failure over a change that happened', async () => {
    // The symptom: reassigning succeeded in the database and the page still
    // said "the server could not complete that request because of a database
    // error". Two separate faults produced it.
    //
    // (a) The history INSERT ran unrelated to the asset UPDATE, so an
    //     asset_events table from an older version — missing routed_to_id or
    //     note — failed after the assignment had already committed.
    // (b) Building the response re-read the asset, and the notes, submissions
    //     and feedback joins threw rather than degrading, so a missing
    //     enrichment table turned a good write into a 500.
    const asset = await newAsset('Post-Write Failure');
    const before = await sql(cfg, `SELECT assignee_id FROM assets WHERE id = '${asset}'`);

    // (a) A history write that cannot land must take the whole change with it.
    await sql(cfg, 'ALTER TABLE asset_events DROP COLUMN routed_to_id');
    let res;
    try {
      res = await call(`/assets/${asset}`, {
        token: token.admin, method: 'PATCH', body: { assigneeId: people.other },
      });
    } finally {
      await sql(cfg, 'ALTER TABLE asset_events ADD COLUMN routed_to_id CHAR(36) NULL');
    }
    assert.strictEqual(res.status, 500, 'a history that cannot be written is a real failure');
    const after = await sql(cfg, `SELECT assignee_id FROM assets WHERE id = '${asset}'`);
    assert.strictEqual(after[0].assignee_id, before[0].assignee_id,
      'and it rolls the assignment back rather than reporting failure over a change that happened');

    // (b) Enrichment the response does not need must never fail the request.
    for (const [what, drop, restore] of [
      ['notes.author_id', 'ALTER TABLE notes DROP FOREIGN KEY fk_notes_author, DROP COLUMN author_id',
                          'ALTER TABLE notes ADD COLUMN author_id CHAR(36) NULL'],
      ['asset_versions',  'RENAME TABLE asset_versions TO asset_versions_bak',
                          'RENAME TABLE asset_versions_bak TO asset_versions'],
      ['feedback',        'RENAME TABLE feedback TO feedback_bak',
                          'RENAME TABLE feedback_bak TO feedback'],
    ]) {
      const target = (await sql(cfg, `SELECT assignee_id FROM assets WHERE id = '${asset}'`))[0].assignee_id
        === people.other ? people.artist : people.other;
      await sql(cfg, drop);
      let out;
      try {
        out = await call(`/assets/${asset}`, {
          token: token.admin, method: 'PATCH', body: { assigneeId: target },
        });
      } finally {
        await sql(cfg, restore);
      }
      assert.strictEqual(out.status, 200, `${what} is enrichment — losing it must not fail the write`);
      const row = await sql(cfg, `SELECT assignee_id FROM assets WHERE id = '${asset}'`);
      assert.strictEqual(row[0].assignee_id, target, `${what}: and the change still landed`);
    }
  });

  await t.test('an older asset_events table gains the columns it is missing', async () => {
    // CREATE TABLE IF NOT EXISTS does nothing to a table that already exists,
    // so an asset_events from an earlier version kept its old columns forever
    // and every reassignment failed on the history write.
    await sql(cfg, 'ALTER TABLE asset_events DROP COLUMN note');
    await sql(cfg, 'ALTER TABLE asset_events DROP COLUMN routed_to_id');

    const schemaCheck = require('../src/schema-check');
    const mysql = require('mysql2/promise');
    const conn = await mysql.createConnection({
      host: cfg.host, port: cfg.port, user: cfg.user, password: cfg.password, database: cfg.database,
    });
    const db = { query: async (text, params = []) => {
      const ordered = [];
      const sqlText = text.replace(/\$(\d+)/g, (_, n) => { ordered.push(params[Number(n) - 1]); return '?'; });
      const [out] = await conn.query(sqlText, ordered.length ? ordered : params);
      return { rows: Array.isArray(out) ? out : [], result: out };
    } };
    try {
      const gaps = await schemaCheck.gaps(db);
      for (const col of ['asset_events.note', 'asset_events.routed_to_id']) {
        assert.ok(gaps.some((g) => g.name === col), `health should name ${col}`);
      }
      await require('../src/migrate').run(db, () => {});
    } finally {
      await conn.end();
    }

    const columns = (await sql(cfg, 'SHOW COLUMNS FROM asset_events')).map((r) => r.Field);
    assert.ok(columns.includes('note'), 'note was added back');
    assert.ok(columns.includes('routed_to_id'), 'routed_to_id was added back');

    // And the write that was failing now works.
    const asset = await newAsset('After The Column Repair');
    const res = await call(`/assets/${asset}`, {
      token: token.admin, method: 'PATCH', body: { assigneeId: people.other },
    });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    const events = await sql(cfg, `SELECT action, note FROM asset_events WHERE asset_id = '${asset}' ORDER BY seq DESC LIMIT 1`);
    assert.strictEqual(events[0].action, 'reassign');
    assert.match(String(events[0].note), /Reassigned from/);
  });

  await t.test('a submission without a valid link is refused', async () => {
    const id = await newAsset('Linkless');
    for (const body of [{}, { link: '' }, { link: 'not a url' }, { description: 'notes only' }]) {
      const res = await act(id, 'submit', 'artist', body);
      assert.strictEqual(res.status, 400, `${JSON.stringify(body)} should be refused`);
      assert.strictEqual(res.body.field, 'link');
    }
    assert.strictEqual(await statusOf(id), 'assigned', 'and nothing moved');

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
    // Each event says where it came from and where it went. Submitting straight
    // from Assigned is the legal shortcut — it just records no time.
    assert.deepStrictEqual(events.map((e) => e.toStatus), [
      'assigned', 'pending_tl_review', 'tl_changes_requested',
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
    assert.strictEqual(await statusOf(id), 'assigned');

    // And somebody who did not add it is refused one step earlier, on
    // ownership, whatever the status they asked for.
    const notTheirs = await newAsset('Someone Else\'s');
    const outsider = await call(`/assets/${notTheirs}`, {
      token: token.lead, method: 'PATCH', body: { status: 'delivered' },
    });
    assert.strictEqual(outsider.status, 403);
    assert.strictEqual(await statusOf(notTheirs), 'assigned');
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
    assert.strictEqual(forced.fromStatus, 'assigned');
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
