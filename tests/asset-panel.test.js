const test = require('node:test');
const assert = require('node:assert');
const { config, resetSchema, startServer, stopServer, api, sql, systemClientId, SKIP_REASON } = require('./helpers');
const submissionLink = require('../src/submission-link');

const cfg = config('assetpanel');

// --- the link rules, shared between the brief and the submission ---------------

test('the reference link is the submission link, made optional', () => {
  // One validator, so "that is not a valid link" cannot come to mean two
  // different things on one screen.
  assert.ok(!submissionLink.validate('').ok, 'a submission needs one');
  const blank = submissionLink.validate('', { optional: true });
  assert.ok(blank.ok);
  assert.strictEqual(blank.link, null, 'and clearing the brief is allowed');
  assert.strictEqual(submissionLink.validate('   ', { optional: true }).link, null);

  for (const bad of ['not a link', 'javascript:alert(1)', 'mailto:someone@example.test']) {
    assert.ok(!submissionLink.validate(bad, { optional: true }).ok, `${bad} should be refused`);
  }
  for (const good of ['https://drive.example.com/brief', 'http://nas/refs/ep01', 'smb://server/share']) {
    assert.ok(submissionLink.validate(good, { optional: true }).ok, `${good} should be accepted`);
  }
});

// --- against a live server -----------------------------------------------------

test('the asset side panel', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Panel-Test-1!';
  let server;
  let projectId;
  const token = {};
  const people = {};

  const call = (path, options) => api(server.base, path, options);
  const as = (who, path, options = {}) => call(path, { ...options, token: token[who] });
  const seenBy = async (who, id) =>
    (await as(who, `/assets/project/${projectId}`)).body.assets.find((x) => x.id === id);
  const historyOf = async (id, who = 'root') => (await as(who, `/assets/${id}/history`)).body.events;

  async function newAsset(who, name, assigneeId) {
    const res = await as(who, `/assets/project/${projectId}`, {
      method: 'POST', body: { name, type: 'character', ...(assigneeId ? { assigneeId } : {}) },
    });
    assert.strictEqual(res.status, 201, JSON.stringify(res.body));
    return res.body.asset;
  }

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'panel-token' });
    await call('/auth/bootstrap', {
      method: 'POST',
      body: { token: 'panel-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD },
    });
    const login = async (email) => (await call('/auth/login', {
      method: 'POST', body: { email, password: PASSWORD },
    })).body.token;
    token.root = await login('root@zvky.test');
    const clientId = await systemClientId(server.base, token.root);
    projectId = (await as('root', '/projects', {
      method: 'POST', body: { clientId, name: 'Nightgarden' },
    })).body.project.id;

    for (const [who, role] of [['pat', 'producer'], ['quinn', 'producer'], ['lee', 'team_lead'],
      ['dana', 'art_director'], ['ana', 'game_artist'], ['bo', 'game_artist']]) {
      const res = await call('/users', {
        token: token.root, method: 'POST',
        body: { name: who, email: `${who}@zvky.test`, role, password: PASSWORD, projectId },
      });
      assert.strictEqual(res.status, 201, JSON.stringify(res.body));
      people[who] = res.body.user.id;
      token[who] = await login(`${who}@zvky.test`);
    }
    for (const artist of ['ana', 'bo']) {
      await as('root', `/users/${people[artist]}`, {
        method: 'PATCH', body: { reportsToId: people.lee, teamLeadId: people.lee },
      });
    }
  });

  t.after(() => stopServer(server));

  // --- 1. changing the assignee from the panel -----------------------------------

  await t.test('the creator can change the assignee, and it lands in the history', async () => {
    const asset = await newAsset('pat', 'Hero Prop', people.ana);

    const res = await as('pat', `/assets/${asset.id}`, { method: 'PATCH', body: { assigneeId: people.bo } });
    assert.strictEqual(res.status, 200, JSON.stringify(res.body));
    assert.strictEqual(res.body.asset.assignee_id, people.bo);
    assert.strictEqual(res.body.asset.assignee_name, 'bo');

    // The new assignee has it; the old one does not.
    assert.ok(await seenBy('bo', asset.id), 'it is in their queue');
    assert.strictEqual(await seenBy('ana', asset.id), undefined);

    const events = await historyOf(asset.id);
    const move = events[events.length - 1];
    assert.strictEqual(move.action, 'reassign');
    assert.match(move.note, /from ana to bo/);
    assert.strictEqual(move.actor, 'pat', 'attributed to whoever made the change');
    assert.ok(move.at);
  });

  await t.test('a mid-review reassignment is recorded, and moves the asset', async () => {
    // Two things this covers, both of which were once wrong.
    //
    // First the trail: the old code updated the routing and wrote nothing, so
    // an asset could change hands mid-pipeline with no trace of who moved it.
    //
    // Then the destination. This dropdown and the Hand over button are two
    // controls for one operation, and only the button ran the transition — so
    // handing submitted work on from here left it in TL Review with the new
    // person's name on it. Assigned to them, and nowhere near the Assigned
    // column they were looking in. Both routes land in the same place now.
    const asset = await newAsset('pat', 'Mid Flight', people.ana);
    await as('ana', `/assets/${asset.id}/start`, { method: 'POST' });
    assert.strictEqual((await as('ana', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/v1', description: 'First pass' },
    })).status, 201);

    const done = await as('pat', `/assets/${asset.id}`, {
      method: 'PATCH', body: { assigneeId: people.bo },
    });
    assert.strictEqual(done.status, 200);
    assert.strictEqual(done.body.asset.status, 'assigned',
      'submitted work handed on goes back to Assigned for whoever takes it');

    const events = await historyOf(asset.id);
    assert.deepStrictEqual(events.map((e) => e.action), ['assign', 'accept', 'submit', 'reassign_review']);
    assert.match(events[3].note, /from ana to bo/);

    // And the new assignee finds it where they would look for it.
    const theirs = await seenBy('bo', asset.id);
    assert.ok(theirs, 'it is in their queue');
    assert.strictEqual(theirs.status, 'assigned');
  });

  await t.test('changing the assignee uses the reassign permission, not a new one', async () => {
    const mine = await newAsset('pat', 'Whose Call', people.ana);

    // Another Producer holds asset.assign and did not add this asset.
    assert.strictEqual((await as('quinn', `/assets/${mine.id}`, {
      method: 'PATCH', body: { assigneeId: people.bo },
    })).status, 403);
    // Nor the person carrying it.
    assert.strictEqual((await as('ana', `/assets/${mine.id}`, {
      method: 'PATCH', body: { assigneeId: people.bo },
    })).status, 403);
    // Full access reaches anything, as everywhere else.
    assert.strictEqual((await as('root', `/assets/${mine.id}`, {
      method: 'PATCH', body: { assigneeId: people.bo },
    })).status, 200);
  });

  // --- 2. the reference link -----------------------------------------------------

  await t.test('the brief link is separate from a submission link', async () => {
    const asset = await newAsset('pat', 'Briefed', people.ana);

    const saved = await as('pat', `/assets/${asset.id}`, {
      method: 'PATCH', body: { referenceLink: '  https://drive.example.com/brief  ' },
    });
    assert.strictEqual(saved.status, 200);
    assert.strictEqual(saved.body.asset.reference_link, 'https://drive.example.com/brief', 'trimmed and stored');

    // The assignee submits work. Two links now exist, and they are not the same
    // field — which is the whole point of adding a second one.
    await as('ana', `/assets/${asset.id}/start`, { method: 'POST' });
    await as('ana', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://drive.example.com/render-v1', description: 'First pass' },
    });
    const seen = await seenBy('ana', asset.id);
    assert.strictEqual(seen.reference_link, 'https://drive.example.com/brief');
    assert.strictEqual(seen.versions[0].link, 'https://drive.example.com/render-v1');
    assert.notStrictEqual(seen.reference_link, seen.versions[0].link);

    // Optional, and clearable.
    assert.strictEqual((await as('pat', `/assets/${asset.id}`, {
      method: 'PATCH', body: { referenceLink: '' },
    })).body.asset.reference_link, null);

    // Validated the same way a submission link is.
    const bad = await as('pat', `/assets/${asset.id}`, { method: 'PATCH', body: { referenceLink: 'not a link' } });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual(bad.body.field, 'referenceLink');
  });

  await t.test('everyone who can see the asset can read the brief; only the creator writes it', async () => {
    const asset = await newAsset('pat', 'Read Only Brief', people.ana);
    await as('pat', `/assets/${asset.id}`, {
      method: 'PATCH', body: { referenceLink: 'https://drive.example.com/spec' },
    });

    // The assignee needs to read it to do the job.
    assert.strictEqual((await seenBy('ana', asset.id)).reference_link, 'https://drive.example.com/spec');
    // And cannot change it — that is the brief, and editing it is asset.edit.
    assert.strictEqual((await as('ana', `/assets/${asset.id}`, {
      method: 'PATCH', body: { referenceLink: 'https://drive.example.com/mine' },
    })).status, 403);
    assert.strictEqual((await as('quinn', `/assets/${asset.id}`, {
      method: 'PATCH', body: { referenceLink: 'https://drive.example.com/theirs' },
    })).status, 403);
  });

  // --- 3. the checklist ----------------------------------------------------------

  await t.test('tasks can be added, ticked, renamed and deleted', async () => {
    const asset = await newAsset('pat', 'Checklist', people.ana);
    const before = (await as('pat', `/assets/${asset.id}/tasks`)).body;
    assert.strictEqual(before.total, 3, 'every asset starts with the three seeded steps');
    assert.strictEqual(before.done, 0);

    const made = await as('pat', `/assets/${asset.id}/tasks`, { method: 'POST', body: { name: '  Paint pass  ' } });
    assert.strictEqual(made.status, 201);
    assert.strictEqual(made.body.task.name, 'Paint pass', 'trimmed');
    assert.strictEqual(made.body.task.created_by, people.pat, 'and attributed');
    const taskId = made.body.task.id;

    assert.strictEqual((await as('pat', `/assets/tasks/${taskId}`, { method: 'PATCH', body: { done: true } })).status, 200);
    const ticked = (await as('pat', `/assets/${asset.id}/tasks`)).body;
    assert.strictEqual(ticked.total, 4);
    assert.strictEqual(ticked.done, 1, 'the progress count is the server\'s answer, not the browser\'s');

    const renamed = await as('pat', `/assets/tasks/${taskId}/text`, { method: 'PATCH', body: { name: 'Paint and polish' } });
    assert.strictEqual(renamed.status, 200);
    assert.strictEqual((await as('pat', `/assets/${asset.id}/tasks`)).body.tasks.find((x) => x.id === taskId).name,
      'Paint and polish');
    assert.ok((await as('pat', `/assets/tasks/${taskId}/text`, { method: 'PATCH', body: { name: '  ' } })).status === 400);

    assert.strictEqual((await as('pat', `/assets/tasks/${taskId}`, { method: 'DELETE' })).status, 200);
    assert.strictEqual((await as('pat', `/assets/${asset.id}/tasks`)).body.total, 3);
  });

  await t.test('a checklist belongs to its own asset', async () => {
    const one = await newAsset('pat', 'Asset One', people.ana);
    const two = await newAsset('pat', 'Asset Two', people.ana);

    await as('pat', `/assets/${one.id}/tasks`, { method: 'POST', body: { name: 'Only on one' } });
    const onTwo = (await as('pat', `/assets/${two.id}/tasks`)).body.tasks.map((x) => x.name);
    assert.ok(!onTwo.includes('Only on one'), 'and does not leak to another');
    assert.ok((await as('pat', `/assets/${one.id}/tasks`)).body.tasks.map((x) => x.name).includes('Only on one'));

    // Deleting the asset takes its checklist with it, and nothing else's.
    // Through root: a Producer creates assets but does not hold asset.delete.
    assert.strictEqual((await as('root', `/assets/${one.id}`, { method: 'DELETE' })).status, 200);
    const orphans = await sql(cfg, `SELECT COUNT(*) AS n FROM tasks WHERE asset_id = '${one.id}'`);
    assert.strictEqual(Number(orphans[0].n), 0);
    assert.strictEqual((await as('pat', `/assets/${two.id}/tasks`)).body.total, 3);
  });

  await t.test('the checklist is set by the creator and the reviewers', async () => {
    // The decision worth naming: the checklist is what the asset is measured
    // against, so it is written by the people who define and check the work.
    const asset = await newAsset('pat', 'Working Group', people.ana);
    const tick = (who) => as(who, `/assets/${asset.id}/tasks`, { method: 'POST', body: { name: `note from ${who}` } });

    assert.strictEqual((await tick('pat')).status, 201, 'the creator');
    assert.strictEqual((await tick('lee')).status, 201, 'their team lead');
    assert.strictEqual((await tick('dana')).status, 201, 'the creative director');
    assert.strictEqual((await tick('root')).status, 201, 'full access');

    // Another Producer can, and this is a consequence of review.tl belonging to
    // every Production role rather than only to team leads: the checklist is
    // open to the asset's reviewers, and they are now among them. Widening the
    // review gate widens this with it — one permission, several doors.
    assert.strictEqual((await tick('quinn')).status, 201, 'a second Producer reviews here too');

    // An artist with no part in it still cannot.
    const refused = await tick('bo');
    assert.strictEqual(refused.status, 403);
    assert.match(refused.body.error, /set by whoever added this asset and by its reviewers/);

    // Reading it is open to anyone who can see the asset, and the answer the
    // screen uses says whether to offer a control at all.
    const read = await as('ana', `/assets/${asset.id}/tasks`);
    assert.strictEqual(read.status, 200, 'the assignee reads the list they work to');
    assert.strictEqual(read.body.canManage, false,
      'so the screen does not offer a control that would be refused');
  });

  await t.test('the assignee reads the checklist and cannot change any of it', async () => {
    // Reversing an earlier default. Carrying the work does not carry the right
    // to decide what the work is — including ticking an item off, which is a
    // claim that something is finished and belongs to whoever checks it.
    const asset = await newAsset('pat', 'Not Yours To Set', people.ana);
    const seed = await as('pat', `/assets/${asset.id}/tasks`, { method: 'POST', body: { name: 'Rough pass' } });
    assert.strictEqual(seed.status, 201);
    const task = seed.body.task;

    // Reading: yes, in full.
    const read = await as('ana', `/assets/${asset.id}/tasks`);
    assert.strictEqual(read.status, 200, 'the list is theirs to read');
    assert.ok(read.body.tasks.length >= 1);
    assert.strictEqual(read.body.canManage, false,
      'and the answer the screen uses to decide whether to offer any control');

    // Writing: none of it. All four routes, including the checkbox.
    const add = await as('ana', `/assets/${asset.id}/tasks`, { method: 'POST', body: { name: 'mine' } });
    assert.strictEqual(add.status, 403, 'cannot add');
    assert.match(add.body.error, /Being assigned the work does not carry the right/);
    assert.strictEqual((await as('ana', `/assets/tasks/${task.id}/text`, {
      method: 'PATCH', body: { name: 'renamed' },
    })).status, 403, 'cannot rename');
    assert.strictEqual((await as('ana', `/assets/tasks/${task.id}`, {
      method: 'PATCH', body: { done: true },
    })).status, 403, 'cannot tick it off');
    assert.strictEqual((await as('ana', `/assets/tasks/${task.id}`, {
      method: 'DELETE',
    })).status, 403, 'cannot delete');

    // Nothing moved. (An asset is seeded with a default checklist, so this
    // counts the change rather than the total.)
    const after = await as('pat', `/assets/${asset.id}/tasks`);
    assert.strictEqual(after.body.tasks.length, read.body.tasks.length,
      'no item was added');
    const mine = after.body.tasks.find((x) => x.id === task.id);
    assert.strictEqual(mine.name, 'Rough pass', 'nor renamed');
    assert.strictEqual(mine.done, false, 'nor ticked off');
    assert.ok(!after.body.tasks.some((x) => x.name === 'mine'), 'and nothing of theirs got in');

    // And carrying the work is untouched: starting it and submitting it are
    // still the assignee's, which is the half of this that must not change.
    assert.strictEqual((await as('ana', `/assets/${asset.id}/start`, { method: 'POST' })).status, 200,
      'Accept and Start still theirs');
    assert.strictEqual((await as('ana', `/assets/${asset.id}/submit`, {
      method: 'POST', body: { link: 'https://example.test/still-mine' },
    })).status, 201, 'Submit for review still theirs');
  });

  await t.test('a closed project freezes the checklist and the brief', async () => {
    const asset = await newAsset('pat', 'Frozen', people.ana);
    const seen = await seenBy('pat', asset.id);
    await as('root', `/projects/${projectId}/close`, { method: 'POST', body: { confirm: true } });

    for (const [method, path, body] of [
      ['POST', `/assets/${asset.id}/tasks`, { name: 'Late' }],
      ['PATCH', `/assets/tasks/${seen.tasks[0].id}`, { done: true }],
      ['PATCH', `/assets/tasks/${seen.tasks[0].id}/text`, { name: 'Renamed' }],
      ['DELETE', `/assets/tasks/${seen.tasks[0].id}`, undefined],
      ['PATCH', `/assets/${asset.id}`, { referenceLink: 'https://example.test/x' }],
    ]) {
      const res = await as('pat', path, { method, body });
      assert.strictEqual(res.status, 409, `${method} ${path}`);
      assert.strictEqual(res.body.projectClosed, true);
    }
    // Still readable, as everywhere else.
    assert.strictEqual((await as('pat', `/assets/${asset.id}/tasks`)).status, 200);

    await as('root', `/projects/${projectId}/reopen`, { method: 'POST' });
    assert.strictEqual((await as('pat', `/assets/${asset.id}/tasks`, {
      method: 'POST', body: { name: 'Fine now' },
    })).status, 201);
  });
});

test('category and man-hours survive the round trip', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Panel-Cat-1!';
  let server; let token; let projectId;

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'tok' });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'tok', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    token = (await api(server.base, '/auth/login', { method: 'POST',
      body: { email: 'root@zvky.test', password: PASSWORD } })).body.token;
    const clientId = await systemClientId(server.base, token);
    projectId = (await api(server.base, '/projects', { method: 'POST', token,
      body: { clientId, name: 'Cat Target' } })).body.project.id;
  });
  t.after(() => stopServer(server));

  await t.test('the list ships empty and an asset may be created without one', async () => {
    const before = await api(server.base, '/reference/categories', { token });
    assert.deepStrictEqual(before.body.entries, [], 'no category should be invented for the studio');

    const made = await api(server.base, `/assets/project/${projectId}`, { method: 'POST', token,
      body: { name: 'No Category', type: 'prop' } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    assert.strictEqual(made.body.asset.category, null);
  });

  await t.test('a category that is not in the managed list is refused', async () => {
    const bad = await api(server.base, `/assets/project/${projectId}`, { method: 'POST', token,
      body: { name: 'Typo Category', type: 'prop', category: 'slot_gaem' } });
    assert.strictEqual(bad.status, 400, JSON.stringify(bad.body));
    assert.strictEqual(bad.body.field, 'category');
  });

  await t.test('man-hours given at creation is the same field the panel edits', async () => {
    const added = await api(server.base, '/reference/categories', { method: 'POST', token,
      body: { label: 'Slot Game' } });
    assert.strictEqual(added.status, 201, JSON.stringify(added.body));
    const key = added.body.entry.key;

    const made = await api(server.base, `/assets/project/${projectId}`, { method: 'POST', token,
      body: { name: 'Full House', type: 'prop', category: key, manHours: 16 } });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    const id = made.body.asset.id;
    assert.strictEqual(made.body.asset.category, key);
    assert.strictEqual(Number(made.body.asset.man_hours), 16);

    /* The estimate and the tracked time are different columns and must stay
       that way: nothing typed into Man Hours may show up as Time Spent. */
    assert.strictEqual(Number(made.body.asset.time_spent_seconds || 0), 0);

    // The panel PATCHes the same fields it was created with.
    await api(server.base, `/assets/${id}`, { method: 'PATCH', token, body: { manHours: 24 } });
    const listed = (await api(server.base, `/assets/project/${projectId}`, { token }))
      .body.assets.find((a) => a.id === id);
    assert.strictEqual(Number(listed.man_hours), 24, 'the panel edits the creation field, not a second one');
    assert.strictEqual(listed.category, key);
    assert.strictEqual(Number(listed.time_spent_seconds || 0), 0);

    // And clearing it is sending an empty value, stored as absence.
    await api(server.base, `/assets/${id}`, { method: 'PATCH', token, body: { category: '' } });
    const cleared = (await api(server.base, `/assets/project/${projectId}`, { token }))
      .body.assets.find((a) => a.id === id);
    assert.strictEqual(cleared.category, null);
  });
});

test('a Category select never misrepresents the value it was given', () => {
  /* The bug this covers: a <select> whose options do not include the current
     value silently selects the first one. With "— None —" first, an asset
     holding a category the browser had not loaded yet — one an import had just
     created, or one since deactivated — displayed as having none, and the next
     edit to any other field would have looked like the user cleared it. */
  const fs = require('fs');
  const page = fs.readFileSync(require('path').join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const body = page.slice(page.indexOf('function categoryOptions'));
  const source = body.slice(0, body.indexOf('\n}') + 2);

  const escapeHTML = (t) => String(t).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const CATEGORIES = [{ id: 'slot_game', label: 'Slot Game' }];
  const categoryLabel = (id) => {
    const c = CATEGORIES.find((x) => x.id === id);
    return c ? c.label : id;
  };
  // eslint-disable-next-line no-new-func
  const categoryOptions = new Function('CATEGORIES', 'categoryLabel', 'escapeHTML',
    `${source}; return categoryOptions;`)(CATEGORIES, categoryLabel, escapeHTML);

  const known = categoryOptions('slot_game');
  assert.match(known, /<option value="slot_game" selected>Slot Game<\/option>/);

  // The one that matters: a value the list does not hold gets its own option.
  const orphan = categoryOptions('bonus_round');
  assert.match(orphan, /<option value="bonus_round" selected>/,
    'an unknown category must still be the selected option');
  assert.ok(!/— None —<\/option>\s*<option value="slot_game" selected/.test(orphan));

  // And no value at all still selects None.
  assert.match(categoryOptions(''), /<option value="" selected>— None —/);
});
