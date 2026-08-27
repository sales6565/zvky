const test = require('node:test');
const assert = require('node:assert');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON, systemClientId } = require('./helpers');
const { ownsAsset, canAssignAsset, isAwaitingRework, REWORK_STATUSES } = require('../src/permissions');

const cfg = config('assetown');

// --- the rule, in isolation ----------------------------------------------------

test('the two rework states are the ones the pipeline parks changes in', () => {
  assert.deepStrictEqual(REWORK_STATUSES, ['tl_changes_requested', 'cd_changes_requested']);
  assert.ok(isAwaitingRework({ status: 'tl_changes_requested' }));
  assert.ok(isAwaitingRework({ status: 'cd_changes_requested' }));
  for (const status of ['not_started', 'in_progress', 'pending_tl_review',
    'pending_cd_review', 'approved_for_client', 'delivered']) {
    assert.ok(!isAwaitingRework({ status }), `${status} is not a rework state`);
  }
});

test('ownership has exactly two ways to be yes', () => {
  const holder = (perms, role) => ({ id: 'u1', role, permissions: perms });
  const editor = holder(['asset.edit'], 'producer');
  const boss = holder(['asset.edit'], 'super_admin');

  assert.ok(!ownsAsset(editor, { created_by: 'someone', assignee_id: 'other' }),
    'holding the permission is not enough on its own');
  assert.ok(ownsAsset(editor, { created_by: 'u1', assignee_id: 'other' }), 'you added it');
  assert.ok(ownsAsset(boss, { created_by: 'someone', assignee_id: 'other' }), 'full access reaches anything');

  // Being the one carrying the work is not ownership.
  assert.ok(!ownsAsset(editor, { created_by: 'someone', assignee_id: 'u1' }),
    'the asset on your desk is not thereby yours to edit');

  // An unowned asset — created before the column existed and not attributable.
  assert.ok(!ownsAsset(editor, { created_by: null, assignee_id: 'u1' }),
    'and an unowned one reaches nobody below full access');
  assert.ok(ownsAsset(boss, { created_by: null, assignee_id: null }), 'except full access');

  // Assigning asks the same question behind its own permission.
  const assigner = holder(['asset.assign'], 'producer');
  assert.ok(canAssignAsset(assigner, { created_by: 'u1' }));
  assert.ok(!canAssignAsset(assigner, { created_by: 'other', assignee_id: 'u1' }),
    'being the assignee is not a licence to reassign');
  assert.ok(!canAssignAsset(holder(['asset.edit'], 'producer'), { created_by: 'u1' }),
    'and it is its own permission');
});

// --- against a live server -----------------------------------------------------

test('asset ownership end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'AssetOwn-Test-1!';
  let server;
  let projectId;
  const token = {};
  const people = {};

  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });
  const statusOf = async (id) =>
    (await as('root', `/assets/project/${projectId}`)).body.assets.find((a) => a.id === id).status;
  const seenBy = async (who, id) =>
    (await as(who, `/assets/project/${projectId}`)).body.assets.find((a) => a.id === id);

  async function newAsset(who, name, assigneeId) {
    const res = await as(who, `/assets/project/${projectId}`, {
      method: 'POST', body: { name, type: 'character', ...(assigneeId ? { assigneeId } : {}) },
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body.asset;
  }
  // Drive an asset to TL Changes, which is where Reassign becomes available.
  async function intoRework(assetId, artist) {
    await as(artist, `/assets/${assetId}/timer/start`, { method: 'POST' });
    assert.strictEqual((await as(artist, `/assets/${assetId}/submit`, {
      method: 'POST', body: { link: 'https://example.test/v1', description: 'First pass' },
    })).status, 201);
    assert.strictEqual((await as('lee', `/assets/${assetId}/review`, {
      method: 'POST', body: { decision: 'changes_requested', text: 'Softer light please' },
    })).status, 200);
    assert.strictEqual(await statusOf(assetId), 'tl_changes_requested');
  }

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'own-token' });
    await call('/auth/bootstrap', {
      method: 'POST',
      body: { token: 'own-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD },
    });
    const login = async (email) => (await call('/auth/login', {
      method: 'POST', body: { email, password: PASSWORD },
    })).body.token;
    token.root = await login('root@zvky.test');
    const clientId = await systemClientId(server.base, token.root);
    projectId = (await call('/projects', { token: token.root, method: 'POST', body: { clientId, name: 'Nightgarden' } })).body.project.id;

    for (const [who, role] of [['pat', 'producer'], ['quinn', 'producer'], ['lee', 'team_lead'],
      ['ana', 'game_artist'], ['bo', 'game_artist']]) {
      const res = await call('/users', {
        token: token.root, method: 'POST',
        body: { name: who, email: `${who}@zvky.test`, role, password: PASSWORD, projectId },
      });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      people[who] = res.body.user.id;
      token[who] = await login(`${who}@zvky.test`);
    }
    // Both artists report to the lead, so the lead holds their review gate.
    for (const artist of ['ana', 'bo']) {
      await as('root', `/users/${people[artist]}`, {
        method: 'PATCH', body: { reportsToId: people.lee, teamLeadId: people.lee },
      });
    }
  });

  t.after(() => stopServer(server));

  await t.test('an asset records who added it', async () => {
    const asset = await newAsset('pat', 'Pat Made This', people.ana);
    assert.strictEqual(asset.created_by, people.pat);

    // Including one that arrives through the bulk import, or a projectful of
    // assets would land unowned by whoever uploaded them.
    const assetImport = require('../src/asset-import');
    const header = assetImport.buildTemplateCsv().trim().split('\n')[0];
    const columns = header.split(',');
    const row = columns.map((c) => (/name/i.test(c) ? 'Imported One' : /type/i.test(c) ? 'character'
      : /priority/i.test(c) ? 'med' : '')).join(',');
    const form = new FormData();
    form.append('file', new Blob([`${header}\n${row}\n`], { type: 'text/csv' }), 'assets.csv');
    const res = await fetch(`${server.base}/assets/project/${projectId}/bulk`, {
      method: 'POST', headers: { Authorization: `Bearer ${token.pat}` }, body: form,
    });
    assert.strictEqual(res.status, 201, JSON.stringify(await res.json().catch(() => ({}))));
    const imported = (await as('root', `/assets/project/${projectId}`)).body.assets
      .find((a) => a.name === 'Imported One');
    assert.strictEqual(imported.created_by, people.pat, 'an import belongs to whoever uploaded it');
  });

  await t.test('Asset Edit reaches your own assets and no one else\'s', async () => {
    const mine = await newAsset('pat', 'Mine', people.ana);
    const theirs = await newAsset('quinn', 'Theirs', people.bo);

    assert.strictEqual((await as('pat', `/assets/${mine.id}`, {
      method: 'PATCH', body: { description: 'mine to edit' },
    })).status, 200);

    // Another Producer holds exactly the same permission and cannot touch it.
    const refused = await as('quinn', `/assets/${mine.id}`, {
      method: 'PATCH', body: { description: 'not yours' },
    });
    assert.strictEqual(refused.status, 403, 'the permission is not a studio-wide licence');
    assert.strictEqual((await as('pat', `/assets/${theirs.id}`, {
      method: 'PATCH', body: { description: 'nor this' },
    })).status, 403, 'and it does not work in the other direction either');

    // Nor does holding a review gate.
    assert.strictEqual((await as('lee', `/assets/${mine.id}`, {
      method: 'PATCH', body: { description: 'nope' },
    })).status, 403);

    // Full access is the exception, and it is the only one.
    assert.strictEqual((await as('root', `/assets/${mine.id}`, {
      method: 'PATCH', body: { description: 'root can' },
    })).status, 200);
  });

  await t.test('the artist carrying the work cannot edit its record', async () => {
    // The consequence of creator-only, stated rather than discovered.
    // Contributors never add assets, so the description and the checklist are
    // read-only to the person actually making the thing.
    const asset = await newAsset('pat', 'Ana\'s Work', people.ana);
    assert.strictEqual((await as('ana', `/assets/${asset.id}`, {
      method: 'PATCH', body: { description: 'work in progress' },
    })).status, 403, 'the asset on your desk is not yours to edit');
    const seen = await seenBy('ana', asset.id);
    assert.ok(seen, 'they can still see it');

    // The checklist is no exception. It is what the asset is measured against,
    // so it is set by whoever defined the work and by whoever checks it —
    // including ticking an item off, which is a claim that something is
    // finished. Carrying the work does not carry that.
    assert.strictEqual((await as('ana', `/assets/tasks/${seen.tasks[0].id}`, {
      method: 'PATCH', body: { done: true },
    })).status, 403, 'not even the checkbox on their own work');
    assert.strictEqual((await as('ana', `/assets/${asset.id}/tasks`, {
      method: 'POST', body: { name: 'Something I noticed' },
    })).status, 403);
    // Reading it is untouched — they work to it.
    assert.ok(seen.tasks.length, 'the list is still theirs to read');

    // And an unrelated artist is no closer.
    assert.strictEqual((await as('bo', `/assets/tasks/${seen.tasks[0].id}`, {
      method: 'PATCH', body: { done: true },
    })).status, 403);

    // The pipeline is untouched: submitting is a separate permission, so the
    // work still moves even though the record is not theirs to change.
    await as('ana', `/assets/${asset.id}/timer/start`, { method: 'POST' });
    assert.strictEqual((await as('ana', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/v1', description: 'First pass' },
    })).status, 201, 'and they can still submit it for review');
    assert.strictEqual(await statusOf(asset.id), 'pending_tl_review');

    // The creator retains both.
    assert.strictEqual((await as('pat', `/assets/${asset.id}`, {
      method: 'PATCH', body: { description: 'the brief' },
    })).status, 200);
  });

  await t.test('an unowned asset falls to full access alone', async () => {
    // What the backfill leaves behind for assets it could not attribute.
    const asset = await newAsset('pat', 'Legacy', people.ana);
    await sql(cfg, `UPDATE assets SET created_by = NULL WHERE id = '${asset.id}'`);

    assert.strictEqual((await as('pat', `/assets/${asset.id}`, {
      method: 'PATCH', body: { description: 'x' },
    })).status, 403, 'not even the person who really added it, once the record is gone');
    assert.strictEqual((await as('ana', `/assets/${asset.id}`, {
      method: 'PATCH', body: { description: 'x' },
    })).status, 403, 'nor the person holding it');
    assert.strictEqual((await as('root', `/assets/${asset.id}`, {
      method: 'PATCH', body: { description: 'x' },
    })).status, 200, 'full access is the only way back');
    // A Producer holds review.tl through their department now, so they have a
    // route to reassigning in principle — and are refused on the state instead,
    // because this asset is not in one of the two stages a handover is for.
    assert.strictEqual((await as('pat', `/assets/${asset.id}/reassign`, {
      method: 'POST', body: { assigneeId: people.bo },
    })).status, 409, 'refused on the stage rather than the person');
  });

  await t.test('reassigning through the edit is scoped to your own assets too', async () => {
    const mine = await newAsset('pat', 'Reassign Via Patch', people.ana);
    assert.strictEqual((await as('pat', `/assets/${mine.id}`, {
      method: 'PATCH', body: { assigneeId: people.bo },
    })).status, 200, 'the creator may change the assignee as part of the edit');
    assert.strictEqual((await as('quinn', `/assets/${mine.id}`, {
      method: 'PATCH', body: { assigneeId: people.ana },
    })).status, 403);
    // Nor may the person holding it hand it on.
    assert.strictEqual((await as('bo', `/assets/${mine.id}`, {
      method: 'PATCH', body: { assigneeId: people.ana },
    })).status, 403, 'your own work is not yours to hand to somebody else');
  });

  await t.test('Reassign appears only while an asset waits on changes', async () => {
    const asset = await newAsset('pat', 'Stage Check', people.ana);
    const reassign = (body) => as('pat', `/assets/${asset.id}/reassign`, { method: 'POST', body });

    // Not Assigned / Assigned / In Progress.
    let res = await reassign({ assigneeId: people.bo });
    assert.strictEqual(res.status, 409, 'not before any work has been submitted');
    assert.deepStrictEqual(res.body.allowedStatuses,
      [...REWORK_STATUSES, 'pending_tl_review', 'pending_cd_review'],
      'rework, and work sitting with a reviewer');

    // Waiting on a reviewer IS reassignable now — and it means something
    // different from reassigning rework: the work has been submitted, so
    // handing it on returns it to Assigned for somebody who has not done it.
    await as('ana', `/assets/${asset.id}/timer/start`, { method: 'POST' });
    await as('ana', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/v1', description: 'First pass' },
    });
    assert.strictEqual(await statusOf(asset.id), 'pending_tl_review');
    const handed = await reassign({ assigneeId: people.bo });
    assert.strictEqual(handed.status, 200, 'submitted work can be handed on');
    assert.strictEqual(handed.body.asset.status, 'assigned',
      'and it goes back to Assigned, because the new person has not done it');
    assert.strictEqual(handed.body.reassigned.inReview, true, 'reported as the in-review case');

    // Put it back the way the rest of this test expects.
    await as('bo', `/assets/${asset.id}/timer/start`, { method: 'POST' });
    await as('bo', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/v1b', description: 'Bo picks it up' },
    });
    await as('lee', `/assets/${asset.id}/review`, {
      method: 'POST', body: { decision: 'changes_requested', text: 'Not yet' },
    });
    await reassign({ assigneeId: people.ana });
    assert.strictEqual(await statusOf(asset.id), 'tl_changes_requested');

    // TL Changes: now it is available.
    await as('lee', `/assets/${asset.id}/review`, {
      method: 'POST', body: { decision: 'changes_requested', text: 'Softer light' },
    });
    assert.strictEqual((await reassign({ assigneeId: people.bo })).status, 200);

    // CD Review is the other reviewer's queue, and behaves the same way.
    await as('bo', `/assets/${asset.id}/timer/start`, { method: 'POST' });
    await as('bo', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/v2', description: 'Reworked' },
    });
    await as('lee', `/assets/${asset.id}/review`, { method: 'POST', body: { decision: 'approved' } });
    assert.strictEqual(await statusOf(asset.id), 'pending_cd_review');
    const fromCd = await reassign({ assigneeId: people.ana });
    assert.strictEqual(fromCd.status, 200, 'the director\'s queue too');
    assert.strictEqual(fromCd.body.asset.status, 'assigned');

    // Delivered is where it stops.
    await as('ana', `/assets/${asset.id}/timer/start`, { method: 'POST' });
    await as('ana', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/v3', description: 'Again' },
    });
    await as('lee', `/assets/${asset.id}/review`, { method: 'POST', body: { decision: 'approved' } });
    await as('root', `/assets/${asset.id}/review`, { method: 'POST', body: { decision: 'approved' } });
    await as('root', `/assets/${asset.id}/deliver`, { method: 'POST' });
    assert.strictEqual((await reassign({ assigneeId: people.bo })).status, 409,
      'nothing to hand on once it has shipped');
  });

  await t.test('only the creator may hand the rework on', async () => {
    const asset = await newAsset('pat', 'Whose Call', people.ana);
    await intoRework(asset.id, 'ana');
    const reassign = (who) => as(who, `/assets/${asset.id}/reassign`, {
      method: 'POST', body: { assigneeId: people.bo },
    });

    assert.strictEqual((await reassign('quinn')).status, 403, 'another Producer cannot');
    assert.strictEqual((await reassign('lee')).status, 403, 'nor the reviewer who sent it back');
    assert.strictEqual((await reassign('ana')).status, 403, 'nor the person holding it');
    assert.strictEqual((await as('quinn', `/assets/${asset.id}/reassign-options`)).status, 403,
      'and the picker is closed to them too');

    assert.strictEqual((await reassign('pat')).status, 200, 'the creator can');
    // Full access can too, on somebody else's asset.
    const other = await newAsset('quinn', 'Quinn\'s', people.ana);
    await intoRework(other.id, 'ana');
    assert.strictEqual((await as('root', `/assets/${other.id}/reassign`, {
      method: 'POST', body: { assigneeId: people.bo },
    })).status, 200);
  });

  await t.test('the new assignee inherits the whole thread', async () => {
    const asset = await newAsset('pat', 'Handover', people.ana);
    await intoRework(asset.id, 'ana');

    const options = (await as('pat', `/assets/${asset.id}/reassign-options`)).body;
    assert.ok(options.awaitingRework);
    assert.deepStrictEqual(options.options.map((o) => o.name), ['bo'],
      'the picker offers assignable people on the project, minus whoever holds it');

    const done = await as('pat', `/assets/${asset.id}/reassign`, {
      method: 'POST', body: { assigneeId: people.bo, note: 'ana is out this week' },
    });
    assert.strictEqual(done.status, 200, JSON.stringify(done.body));
    assert.strictEqual(done.body.asset.assignee_id, people.bo);
    assert.strictEqual(done.body.asset.status, 'tl_changes_requested', 'the stage does not move');

    // Everything the original assignee could see.
    const theirs = await seenBy('bo', asset.id);
    assert.ok(theirs, 'it is in their queue');
    assert.deepStrictEqual(theirs.feedback.map((f) => f.text), ['Softer light please'],
      'the reviewer\'s notes came with it');
    assert.strictEqual(theirs.versions.length, 1);
    assert.strictEqual(theirs.versions[0].link, 'https://example.test/v1', 'and the last submission');
    assert.strictEqual(theirs.versions[0].description, 'First pass');

    const history = (await as('bo', `/assets/${asset.id}/history`)).body.events;
    assert.deepStrictEqual(history.map((e) => e.action),
      ['assign', 'accept', 'submit', 'tl_request_changes', 'reassign'],
      'and the whole sequence, with the handover recorded in it');
    assert.match(history[4].note, /from ana to bo — ana is out this week/);
    // And what the outgoing round finally recorded, which is what makes the
    // handover answerable rather than just noted.
    assert.match(history[4].note, /ana recorded/);
    assert.strictEqual(history[4].actor, 'pat', 'attributed to whoever made the call');

    // The person it left no longer holds it.
    assert.strictEqual(await seenBy('ana', asset.id), undefined);
    await as('ana', `/assets/${asset.id}/timer/start`, { method: 'POST' });
    assert.strictEqual((await as('ana', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/x', description: 'still mine?' },
    })).status, 403);

    // And the new one can carry on from where it was left.
    await as('bo', `/assets/${asset.id}/timer/start`, { method: 'POST' });
    assert.strictEqual((await as('bo', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/v2', description: 'Reworked' },
    })).status, 201);
    assert.strictEqual(await statusOf(asset.id), 'pending_tl_review');
  });

  await t.test('a reassign cannot land the asset somewhere illegal', async () => {
    const asset = await newAsset('pat', 'Bad Targets', people.ana);
    await intoRework(asset.id, 'ana');
    const reassign = (body) => as('pat', `/assets/${asset.id}/reassign`, { method: 'POST', body });

    assert.strictEqual((await reassign({})).status, 400, 'somebody has to be named');
    assert.strictEqual((await reassign({ assigneeId: people.ana })).status, 400,
      'and it has to be a change');
    const lead = await reassign({ assigneeId: people.lee });
    assert.strictEqual(lead.status, 400, 'a designation that is not assigned work is refused');
    assert.match(lead.body.error, /not assigned work/i);
    assert.strictEqual((await reassign({ assigneeId: 'no-such-user' })).status, 400);
    assert.strictEqual(await statusOf(asset.id), 'tl_changes_requested', 'and nothing moved');
  });

  await t.test('CD Changes keeps the relay: reassigning does not skip the lead', async () => {
    // In CD Changes the asset sits with the team lead until they relay the
    // notes. Reassigning at that point changes who will receive them, not who
    // is holding them right now.
    const asset = await newAsset('pat', 'Relay Check', people.ana);
    await as('ana', `/assets/${asset.id}/timer/start`, { method: 'POST' });
    await as('ana', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/v1', description: 'First' },
    });
    await as('lee', `/assets/${asset.id}/review`, { method: 'POST', body: { decision: 'approved' } });
    await as('root', `/assets/${asset.id}/review`, {
      method: 'POST', body: { decision: 'changes_requested', text: 'Rework the silhouette' },
    });
    assert.strictEqual(await statusOf(asset.id), 'cd_changes_requested');

    assert.strictEqual((await as('pat', `/assets/${asset.id}/reassign`, {
      method: 'POST', body: { assigneeId: people.bo },
    })).status, 200);

    // Still the lead's to relay, and now it goes to bo.
    await as('bo', `/assets/${asset.id}/timer/start`, { method: 'POST' });
    assert.strictEqual((await as('bo', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/v2', description: 'Too soon' },
    })).status, 403, 'the notes have not been passed on yet');
    assert.strictEqual((await as('lee', `/assets/${asset.id}/relay`, { method: 'POST', body: {} })).status, 200);
    await as('bo', `/assets/${asset.id}/timer/start`, { method: 'POST' });
    assert.strictEqual((await as('bo', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/v2', description: 'Reworked' },
    })).status, 201, 'and then it is theirs');
  });
});
