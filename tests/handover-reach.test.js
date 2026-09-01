const test = require('node:test');
const assert = require('node:assert');
const { config, resetSchema, startServer, stopServer, api, SKIP_REASON, systemClientId } = require('./helpers');

const cfg = config('handreach');

/* Who an asset may be handed to.
 *
 * The bug this file exists for: "Ankita Das is not on this project." Handing
 * work on ran the receiving person through canAccessProject, so a reviewer
 * looking for somebody free could only reach the people already attached to
 * the project — which is the opposite of what the control is for.
 *
 * It was also inconsistent with the picker in front of it. When "Assign Work to
 * Anyone" arrived, both assignee dropdowns were taught to honour it and this
 * check was not, so a holder of that permission was shown the whole studio and
 * refused for choosing from it.
 *
 * The invariant asserted here is the one that broke: every name the picker
 * offers, the endpoint accepts. It is checked by feeding the picker's own
 * output back into the endpoint rather than by comparing two lists written out
 * by hand — a test that restates both rules would agree with itself while the
 * app disagreed with the user.
 */
test('handing work on reaches outside the project', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Handover-Test-1!';
  let server;
  let projectId;
  let otherProjectId;
  const token = {};
  const people = {};

  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });
  const statusOf = async (id) =>
    (await as('root', `/assets/project/${projectId}`)).body.assets.find((a) => a.id === id).status;

  const newAsset = async (name, assigneeId) => {
    const res = await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name, type: 'character', ...(assigneeId ? { assigneeId } : {}) },
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body.asset;
  };
  const submit = async (who, id, note) => {
    await as(who, `/assets/${id}/start`, { method: 'POST' });
    const res = await as(who, `/assets/${id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/' + id, description: note },
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
  };
  const handTo = (who, id, assigneeId) =>
    as(who, `/assets/${id}/reassign`, { method: 'POST', body: { assigneeId } });

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'hand-token' });
    await call('/auth/bootstrap', {
      method: 'POST',
      body: { token: 'hand-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD },
    });
    const login = async (email) => (await call('/auth/login', {
      method: 'POST', body: { email, password: PASSWORD },
    })).body.token;
    token.root = await login('root@zvky.test');
    const clientId = await systemClientId(server.base, token.root);
    const project = (name) => call('/projects', { token: token.root, method: 'POST', body: { clientId, name } });
    projectId = (await project('Nightgarden')).body.project.id;
    otherProjectId = (await project('Tin Rain')).body.project.id;

    // on: attached to Nightgarden. elsewhere: attached to the other project.
    // ankita: attached to no project at all — the reported case.
    const add = async (who, role, onProject) => {
      const res = await call('/users', {
        token: token.root, method: 'POST',
        body: { name: who, email: `${who}@zvky.test`, role, password: PASSWORD,
          ...(onProject ? { projectId: onProject } : {}) },
      });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      people[who] = res.body.user.id;
      token[who] = await login(`${who}@zvky.test`);
    };
    await add('lee', 'team_lead', projectId);
    await add('ana', 'game_artist', projectId);
    await add('onproject', 'game_artist', projectId);
    await add('elsewhere', 'game_artist', otherProjectId);
    await add('ankita', 'game_artist', null);
    // Somebody the studio does not give work to, for the eligibility check.
    await add('fin', 'junior_accountant', null);

    await as('root', `/users/${people.ana}`, {
      method: 'PATCH', body: { reportsToId: people.lee, teamLeadId: people.lee },
    });
  });

  t.after(() => stopServer(server));

  await t.test('the reported case: somebody on no project at all', async () => {
    const asset = await newAsset('Dragon', people.ana);
    await submit('ana', asset.id, 'first pass');
    assert.strictEqual(await statusOf(asset.id), 'pending_tl_review');

    // Independently establish the premise, so a pass cannot come from Ankita
    // quietly being on the project after all.
    assert.strictEqual((await as('ankita', `/assets/project/${projectId}`)).status, 403,
      'Ankita cannot reach this project — which is what used to refuse the handover');

    const res = await handTo('root', asset.id, people.ankita);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.asset.assignee_id, people.ankita);
    assert.strictEqual(res.body.asset.status, 'assigned');
  });

  await t.test('being handed it is what puts them on the project', async () => {
    // The half that makes the fix safe rather than merely permissive: nothing
    // grants Ankita access, so if holding the asset did not carry it she would
    // be assigned work she could not open.
    const mine = (await as('ankita', '/assets/project/' + projectId));
    assert.strictEqual(mine.status, 200, 'the project opens for her now');
    const dragon = mine.body.assets.find((a) => a.name === 'Dragon');
    assert.ok(dragon, 'and the asset she was handed is in it');
    assert.strictEqual(dragon.status, 'assigned');
    assert.strictEqual(dragon.assignee_id, people.ankita);

    const projects = (await as('ankita', '/projects')).body.projects;
    assert.ok(projects.some((p) => p.id === projectId), 'and the project is in her list');

    // The workflow controls are intact: she can take it and submit it.
    assert.strictEqual((await as('ankita', `/assets/${dragon.id}/start`, { method: 'POST' })).status, 200);
    assert.strictEqual((await as('ankita', `/assets/${dragon.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/ankita', description: 'picked up' },
    })).status, 201);
    assert.strictEqual(await statusOf(dragon.id), 'pending_tl_review');
  });

  await t.test('every stage a handover is offered from reaches off the project', async () => {
    // All four, not just the one the bug was reported from.
    const stages = [];

    const tlReview = await newAsset('Stage TL Review', people.ana);
    await submit('ana', tlReview.id, 'v1');
    stages.push(['pending_tl_review', tlReview]);

    const tlFeedback = await newAsset('Stage TL Feedbacks', people.ana);
    await submit('ana', tlFeedback.id, 'v1');
    await as('lee', `/assets/${tlFeedback.id}/review`, {
      method: 'POST', body: { decision: 'changes_requested', text: 'Softer light' } });
    stages.push(['tl_changes_requested', tlFeedback]);

    const cdReview = await newAsset('Stage CD Review', people.ana);
    await submit('ana', cdReview.id, 'v1');
    await as('lee', `/assets/${cdReview.id}/review`, { method: 'POST', body: { decision: 'approved' } });
    stages.push(['pending_cd_review', cdReview]);

    const cdFeedback = await newAsset('Stage CD Feedbacks', people.ana);
    await submit('ana', cdFeedback.id, 'v1');
    await as('lee', `/assets/${cdFeedback.id}/review`, { method: 'POST', body: { decision: 'approved' } });
    await as('root', `/assets/${cdFeedback.id}/review`, {
      method: 'POST', body: { decision: 'changes_requested', text: 'Colour' } });
    stages.push(['cd_changes_requested', cdFeedback]);

    for (const [expected, asset] of stages) {
      assert.strictEqual(await statusOf(asset.id), expected, `${asset.name} should be in ${expected}`);
      const res = await handTo('root', asset.id, people.elsewhere);
      assert.strictEqual(res.status, 200,
        `handing on from ${expected} should reach off the project — ${JSON.stringify(res.body)}`);
      assert.strictEqual(res.body.asset.assignee_id, people.elsewhere);
    }
  });

  await t.test('the picker offers exactly what the endpoint accepts', async () => {
    /* The invariant that broke. Rather than assert the list's contents, take
       every name the picker gives and hand the asset to it — a picker offering
       somebody the submission then refuses is the bug, whichever way the two
       disagree. */
    const asset = await newAsset('Round Trip', people.ana);
    await submit('ana', asset.id, 'v1');

    const picker = await as('root', `/assets/${asset.id}/reassign-options`);
    assert.strictEqual(picker.status, 200);
    const offered = picker.body.options;
    // Four artists in the studio, minus the one already holding it.
    assert.strictEqual(offered.length, 3, 'every artist but the current holder');
    assert.ok(offered.some((o) => o.id === people.ankita), 'Ankita, on no project, is offered');
    assert.ok(offered.some((o) => o.id === people.elsewhere), 'and so is somebody on another project');
    assert.ok(!offered.some((o) => o.id === people.ana), 'the person already holding it is not');
    assert.ok(!offered.some((o) => o.id === people.fin),
      'nor is somebody whose designation is not given work');

    for (const option of offered) {
      const res = await handTo('root', asset.id, option.id);
      assert.strictEqual(res.status, 200,
        `the picker offered ${option.name} and the endpoint refused: ${JSON.stringify(res.body)}`);
      // Back into a handover stage for the next one.
      await submit(Object.keys(people).find((k) => people[k] === option.id), asset.id, 'again');
    }
  });

  await t.test('somebody already on the project still works', async () => {
    const asset = await newAsset('No Regression', people.ana);
    await submit('ana', asset.id, 'v1');
    const res = await handTo('root', asset.id, people.onproject);
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.asset.assignee_id, people.onproject);
  });

  await t.test('the checks that are not about the project are untouched', async () => {
    const asset = await newAsset('Still Guarded', people.ana);

    // Stage: nothing to hand on before it has been submitted.
    let res = await handTo('root', asset.id, people.ankita);
    assert.strictEqual(res.status, 409, 'a stage that cannot be handed on is still refused');

    await submit('ana', asset.id, 'v1');

    // Designation: the studio does not give work to an accountant.
    res = await handTo('root', asset.id, people.fin);
    assert.strictEqual(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error, /designation that is not assigned work/);

    // Actor: an artist with no claim on it cannot hand it to anybody.
    assert.strictEqual((await handTo('onproject', asset.id, people.ankita)).status, 403,
      'who may hand work on is still a real gate');
    assert.strictEqual((await as('onproject', `/assets/${asset.id}/reassign-options`)).status, 403,
      'and the picker is gated the same way');

    // And the obvious ones.
    assert.strictEqual((await handTo('root', asset.id, people.ana)).status, 400,
      'handing it to whoever already holds it');
    assert.strictEqual((await handTo('root', asset.id, 'no-such-user')).status, 400,
      'and to somebody who does not exist');
  });

  await t.test('the other assignment flows were not touched', async () => {
    // Neither of these ever ran a membership check, and the fix must not have
    // added one or taken anything else away.
    const created = await newAsset('Created Off Project', people.ankita);
    assert.strictEqual(created.assignee_id, people.ankita,
      'creating an asset assigned to somebody off the project still works');

    const edited = await as('root', `/assets/${created.id}`, {
      method: 'PATCH', body: { assigneeId: people.elsewhere },
    });
    assert.strictEqual(edited.status, 200, JSON.stringify(edited.body));
    assert.strictEqual(edited.body.asset.assignee_id, people.elsewhere,
      'and changing the assignee through the edit still works');

    // The edit's own gate still holds: an artist cannot reassign somebody's work.
    assert.strictEqual((await as('onproject', `/assets/${created.id}`, {
      method: 'PATCH', body: { assigneeId: people.ana },
    })).status, 403, 'the edit path keeps its own permission check');
  });
});
