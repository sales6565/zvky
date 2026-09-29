/* Assign to Freelancer: the flow end to end, and the one way it could fail in silence.
 *
 * WHAT THE INVESTIGATION FOUND, recorded because the answer was "not where it was expected":
 *
 *   The endpoint works. A Super Admin and a Team Lead on the project both get 201, the
 *   assignment comes back, and the asset then carries outsourced_to. Driven below.
 *
 *   Every refusal SAYS something. Off-project is 403 "No access to that project"; without
 *   the permission it is 403; an asset already staffed inside the studio is 409 naming who
 *   holds it. All four are asserted here, because "the button does nothing" is a report
 *   about feedback as much as about outcome.
 *
 *   DISCIPLINE IS NOT INVOLVED. It was a plausible shape — free text on freelancers against
 *   an expected enum somewhere — and it is not what happens: validateAssignment checks the
 *   freelancer, the project, the hours, the status and the due date, checkRefs checks the
 *   three references, and neither reads discipline. It is stored and displayed, nothing else.
 *   Pinned below so a later change that starts matching on it has to say so.
 *
 *   THE ONE SILENT PATH WAS THE DIALOG. The handler collected the agreed man hours with
 *   prompt(). Browsers suppress prompt() — Chrome and Firefox both do once somebody ticks
 *   "prevent this page from creating additional dialogs", Chrome does outright in a
 *   cross-origin frame — and a suppressed prompt() returns null, which the handler could not
 *   tell from Cancel. So the click did nothing, said nothing, and went on saying nothing.
 *   That was the only exit from the handler with no feedback, and it is now an inline field.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const outsource = require('../src/outsource');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');

const cfg = config('osassign');
const PASSWORD = 'OsAssign-1!';
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

// --- the regression: no silent exit, and no dialog to be suppressed ----------

test('every exit from the assign handler tells the user something', () => {
  /* THE REGRESSION PIN. The failure was not a status code — it was a click that produced
     nothing at all, which no server test can see. So the handler is read and every `return`
     in it is checked for feedback beside it. */
  const at = PAGE.indexOf("const btn = document.getElementById('d_osAssignBtn');");
  assert.ok(at !== -1, 'the assign handler is in the page');
  const body = PAGE.slice(at, PAGE.indexOf('};', PAGE.indexOf('catch(e2)', at)));

  const code = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  /* PER BLOCK, NOT PER LINE. A message and the return that follows it are two statements —
     the first version of this test read one line at a time and failed on its own subject.
     So the handler is cut at each early return and the segment leading up to it must contain
     the feedback: that is the property, whichever line it is written on. */
  const segments = code.split(/\breturn;/);
  const exits = segments.length - 1;
  assert.ok(exits >= 3, `the handler has early exits to check: ${exits}`);
  for (let i = 0; i < exits; i += 1) {
    assert.match(segments[i], /ferr\.textContent/,
      `early exit ${i + 1} returns without saying why:\n${segments[i].slice(-260)}`);
  }

  /* AND NO DIALOG. A prompt() here is a control whose failure mode is invisible, and it was
     the only one in the drawer: every other field in this panel is inline with a .ref-err
     under it. */
  assert.ok(!/prompt\(/.test(code), 'the handler asks for nothing through a browser dialog');
  assert.match(PAGE, /<input type="number" id="d_osHours"/,
    'the agreed hours are an inline field');
  assert.match(body, /const hoursInput = document\.getElementById\('d_osHours'\)/,
    'and the handler reads that field');

  // A blank field is a message, not silence — the case a suppressed dialog used to produce.
  assert.match(code, /if\(!typed\)\{[\s\S]*?ferr\.textContent/,
    'an empty hours field is answered in words');
});

test('the assign flow does not match on discipline anywhere', () => {
  /* Free text on freelancers against an expected value somewhere was the hypothesis. It is
     not the case, and this pins it: a later change that starts validating discipline has to
     fail here first, because doing it quietly would reintroduce exactly the shape that was
     suspected. */
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'outsource.js'), 'utf8');
  const fn = (name) => {
    const at = src.indexOf(`function ${name}(`);
    assert.ok(at !== -1, `${name} is in src/outsource.js`);
    const rest = src.slice(at);
    return rest.slice(0, rest.indexOf('\n}') + 2);
  };
  for (const name of ['validateAssignment', 'checkRefs', 'createAssignment']) {
    assert.ok(!/discipline/.test(fn(name)),
      `${name} must not read discipline — it is free text and means nothing to an assignment`);
  }
  // It is still stored and shown, which is all it was ever for.
  assert.match(src, /discipline: row\.discipline \|\| ''/, 'stored and read back for display');
});

// --- against a live server ---------------------------------------------------

test('assigning a task to a freelancer, and every way it is refused',
  { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const tok = {};
  const id = {};

  const as = (who, p, o = {}) => api(server.base, p, { ...o, token: tok[who] });
  const login = async (email) => (await api(server.base, '/auth/login',
    { method: 'POST', body: { email, password: PASSWORD } })).body.token;
  const assign = (who, body) => as(who, '/outsource/assignments', { method: 'POST', body });
  const assetRow = async (who, projectId, assetId) => {
    const r = await as(who, `/assets/project/${projectId}`);
    return (r.body.assets || []).find((x) => x.id === assetId);
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'os-boot', WORK_HOURS_SWEEP_MINUTES: '0' });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'os-boot', name: 'Root', email: 'root@zvky.test', password: PASSWORD } });
    tok.root = await login('root@zvky.test');
    const mk = async (who, email, role) => {
      const r = await as('root', '/users', { method: 'POST',
        body: { name: who, email, role, password: PASSWORD } });
      assert.strictEqual(r.status, 201, `${role}: ${JSON.stringify(r.body)}`);
      tok[who] = await login(email);
      return r.body.user.id;
    };
    id.lead = await mk('lead', 'lead@zvky.test', 'team_lead');
    id.artist = await mk('artist', 'artist@zvky.test', 'game_artist');

    /* A freelancer whose discipline is exactly the free text the field invites — commas and
       all — because that is what a studio types and it must not matter to an assignment. */
    const fl = await as('root', '/outsource/freelancers', { method: 'POST',
      body: { name: 'Ravi Freelance', discipline: 'animation, rigging', status: 'active' } });
    assert.strictEqual(fl.status, 201, JSON.stringify(fl.body));
    id.freelancer = fl.body.freelancer.id;

    const clients = await as('root', '/clients');
    const mine = await as('root', '/projects', { method: 'POST',
      body: { name: 'Farmed Out', clientId: clients.body.clients[0].id, teamLeadIds: [id.lead] } });
    id.project = mine.body.project.id;
    const other = await as('root', '/projects', { method: 'POST',
      body: { name: 'Not Theirs', clientId: clients.body.clients[0].id } });
    id.otherProject = other.body.project.id;
  });

  t.after(async () => { if (server) await stopServer(server); });

  const freeAsset = async (name, projectId = id.project) => {
    const r = await as('root', `/assets/project/${projectId}`, { method: 'POST',
      body: { name, type: 'prop' } });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    return r.body.asset.id;
  };

  await t.test('the roster the dropdown is built from marks who is available', async () => {
    /* The page filters on f.active, so a list that carried only `status` would leave the
       dropdown empty and the button answering "Pick a freelancer first" forever. */
    const list = await as('root', '/outsource/freelancers');
    assert.strictEqual(list.status, 200, JSON.stringify(list.body));
    const row = (list.body.freelancers || []).find((f) => f.id === id.freelancer);
    assert.ok(row, 'the freelancer is on the roster');
    assert.strictEqual(row.active, true, 'with the flag the dropdown reads');
    assert.strictEqual(row.status, 'active');
    assert.strictEqual(row.discipline, 'animation, rigging', 'and their discipline, as typed');
  });

  await t.test('a lead on the project assigns the task, and the asset shows it', async () => {
    const assetId = await freeAsset('Send This Out');
    const r = await assign('lead', { freelancerId: id.freelancer, projectId: id.project,
      assetId, decidedManHours: 8, description: 'Send This Out' });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    assert.strictEqual(r.body.assignment.freelancerName, 'Ravi Freelance');
    assert.strictEqual(r.body.assignment.decidedManHours, 8);

    const row = await assetRow('lead', id.project, assetId);
    assert.ok(row.outsourced_to, 'the asset carries the assignment');
    assert.strictEqual(row.outsourced_to.freelancerName, 'Ravi Freelance');
    assert.strictEqual(row.outsourced_to.decidedManHours, 8);
  });

  await t.test('zero agreed hours is allowed; a negative one is not', async () => {
    /* The inline field's own rule, and the server's: 0 means "not settled yet", which is a
       real state when work is handed over before the figure is agreed. */
    const ok = await assign('lead', { freelancerId: id.freelancer, projectId: id.project,
      assetId: await freeAsset('Unsettled'), decidedManHours: 0 });
    assert.strictEqual(ok.status, 201, JSON.stringify(ok.body));

    const bad = await assign('lead', { freelancerId: id.freelancer, projectId: id.project,
      assetId: await freeAsset('Negative'), decidedManHours: -3 });
    assert.strictEqual(bad.status, 422, JSON.stringify(bad.body));
    assert.match(bad.body.error, /cannot be negative/);

    const missing = await assign('lead', { freelancerId: id.freelancer, projectId: id.project,
      assetId: await freeAsset('No Hours') });
    assert.strictEqual(missing.status, 422, JSON.stringify(missing.body));
    assert.match(missing.body.error, /agreed man hours/i);
  });

  await t.test('every refusal names its reason', async () => {
    // Off-project, for a designation whose reach is its own team.
    const off = await assign('lead', { freelancerId: id.freelancer, projectId: id.otherProject,
      assetId: await freeAsset('Elsewhere', id.otherProject), decidedManHours: 4 });
    assert.strictEqual(off.status, 403, JSON.stringify(off.body));
    assert.match(off.body.error, /No access to that project/);

    // Without the permission at all.
    const nope = await assign('artist', { freelancerId: id.freelancer, projectId: id.project,
      assetId: await freeAsset('Not Theirs To Send'), decidedManHours: 4 });
    assert.strictEqual(nope.status, 403, JSON.stringify(nope.body));

    /* Already staffed inside the studio — the exclusivity rule, and the message names who
       holds it so the reader knows what to clear. */
    const staffed = await as('root', `/assets/project/${id.project}`, { method: 'POST',
      body: { name: 'Already Ours', type: 'prop', assigneeId: id.artist } });
    const clash = await assign('lead', { freelancerId: id.freelancer, projectId: id.project,
      assetId: staffed.body.asset.id, decidedManHours: 4 });
    assert.strictEqual(clash.status, 409, JSON.stringify(clash.body));
    assert.match(clash.body.error, /assigned to artist/);

    // An inactive freelancer, and a wrong-project asset.
    await as('root', `/outsource/freelancers/${id.freelancer}`, { method: 'PUT',
      body: { name: 'Ravi Freelance', status: 'inactive' } });
    const gone = await assign('lead', { freelancerId: id.freelancer, projectId: id.project,
      assetId: await freeAsset('To Nobody'), decidedManHours: 4 });
    assert.strictEqual(gone.status, 422, JSON.stringify(gone.body));
    assert.match(gone.body.error, /inactive/);
    await as('root', `/outsource/freelancers/${id.freelancer}`, { method: 'PUT',
      body: { name: 'Ravi Freelance', status: 'active' } });

    const crossed = await assign('root', { freelancerId: id.freelancer, projectId: id.project,
      assetId: await freeAsset('Wrong Project', id.otherProject), decidedManHours: 4 });
    assert.strictEqual(crossed.status, 422, JSON.stringify(crossed.body));
    assert.match(crossed.body.error, /different project/);
  });
});
