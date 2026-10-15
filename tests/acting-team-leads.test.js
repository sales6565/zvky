/* ACTING TEAM LEADS.
 *
 * ===========================================================================
 * WHAT THIS GUARDS, and it is one sentence:
 *
 *   BEING AN ACTING TEAM LEAD IS A FACT ABOUT ONE PROJECT.
 *
 * Everything that could go wrong with this feature is a leak out of that
 * sentence — a stand-in on the Hero project who can suddenly see the studio,
 * or approve work on a project nobody put them on, or who quietly acquires a
 * permission their designation does not carry. None of those would look wrong
 * on the screen that created them; they would look wrong on somebody else's
 * screen, weeks later.
 *
 * So the tests below are mostly about the EDGES of that one project: what the
 * person can see, where they can act, and — just as important — where they
 * still cannot.
 *
 * ===========================================================================
 * THE STRUCTURAL HALF, and why it is not optional here.
 *
 * The application decides "may this person act as a lead" in ONE place: the
 * union in src/permissions.js. A fifth reader of the membership tables that
 * answered the same question its own way would agree on the day it was written
 * and drift afterwards — which is how the three existing tables already ended
 * up with four direct readers apiece. The new table is therefore held to an
 * ALLOWLIST: a named set of files may mention it and nothing else may, and the
 * test below fails on the first file that does.
 *
 * FIXED DATA THROUGHOUT. Nothing here reads a clock.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const { config, resetSchema, startServer, stopServer, api, sql, openStudio,
  systemClientId, SKIP_REASON } = require('./helpers');

const permissions = require('../src/permissions');
const { roleDef } = require('../src/roles');

const ROOT = path.join(__dirname, '..');
const PAGE = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const SRC = (f) => fs.readFileSync(path.join(ROOT, 'src', f), 'utf8');

const cfg = config('acting');
const PASSWORD = 'Acting-TL-1!';
const TABLE = 'project_acting_team_leads';

// ===========================================================================
// 1. THE SHARED DEFINITION, AND THAT NOTHING GOES ROUND IT.
// ===========================================================================

test('the acting list is a fourth entry in the one shared table list', () => {
  assert.ok(permissions.PROJECT_TEAM_TABLES.includes(TABLE),
    'the review-team union includes it');
  assert.strictEqual(permissions.PROJECT_LEAD_TABLES, permissions.PROJECT_TEAM_TABLES,
    '"who may act at the TL gate" and "who is a lead here" are one list, not two copies');
  assert.deepStrictEqual(permissions.PROJECT_TEAM_TABLES, [
    'project_team_leads', TABLE, 'project_coordinators', 'project_supervision',
  ], 'and the three that were there are still there, in order');
  assert.strictEqual(typeof permissions.projectLeadIds, 'function');
  assert.strictEqual(typeof permissions.isProjectLead, 'function');
});

test('MUTATION e — only an allowlist of files may name the acting table', () => {
  /* SCOPED TO THE NEW TABLE, deliberately. The three that predate it have four
     direct readers each — the assign-artist picker, clients.js, the user
     import, user-project.js — and refactoring those is a different change from
     this one. What this guards is that the NEW list does not acquire a fifth
     reader the way they did.
     
     Each entry says why it is allowed, so adding one is an argument rather
     than an edit. */
  const ALLOWED = new Map([
    ['migrate.js', 'creates the table'],
    ['permissions.js', 'owns the union, the visibility rule and the authority label'],
    ['assignments.js', 'adds acting leads to the submission audience — ruling 4'],
    ['routes/projects.js', 'the only writer, and withMembers() reads it back for the form'],
  ]);
  /* THE SEED IS NOT ON IT, and that is a decision rather than an omission: a
     seeded studio starts with no stand-ins, because a stand-in is something
     somebody decides this fortnight. Add the entry when the seed grows one. */

  const walk = (dir, out = []) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, out);
      else if (entry.name.endsWith('.js')) out.push(full);
    }
    return out;
  };

  const offenders = [];
  for (const file of walk(path.join(ROOT, 'src'))) {
    const rel = path.relative(path.join(ROOT, 'src'), file);
    if (!fs.readFileSync(file, 'utf8').includes(TABLE)) continue;
    if (!ALLOWED.has(rel)) offenders.push(rel);
  }
  assert.deepStrictEqual(offenders, [],
    `these files read ${TABLE} directly; route them through permissions.projectLeadIds() instead`);

  /* AND EVERY ALLOWED FILE ACTUALLY USES IT — an allowlist that outlived its
     entries would quietly permit a file that no longer needs permission. */
  for (const [rel, why] of ALLOWED) {
    assert.ok(fs.readFileSync(path.join(ROOT, 'src', rel), 'utf8').includes(TABLE),
      `${rel} is on the allowlist for "${why}" but no longer reads the table`);
  }
});

test('the page never names the table, and never decides who is a lead', () => {
  assert.ok(!PAGE.includes(TABLE), 'the browser is told, never asked');
  /* It carries ids the server sent and sends ids back; the word "acting" in the
     page is a section heading and a field name, not a rule. */
  assert.match(PAGE, /actingTeamLeadIds/);
});

// ===========================================================================
// 2. THE PAGE: one renderer, four sections, one new rule.
// ===========================================================================

test('both project forms go through the one checklist renderer', () => {
  /* ADD PROJECT USED TO INLINE THE MARKUP BY HAND while Edit Project called
     epChecklist — the same list drawn two ways, which is how a fifth variant
     gets written. The inline pair is gone. */
  const inlineLead = /document\.getElementById\('p_leads'\)\.innerHTML = leads\.map/;
  const inlineCoord = /document\.getElementById\('p_coords'\)\.innerHTML = coords\.map/;
  assert.ok(!inlineLead.test(PAGE), 'Add Project no longer inlines the leads checklist');
  assert.ok(!inlineCoord.test(PAGE), 'nor the coordinators one');

  for (const call of [
    /epChecklist\('p_leads', leads, \[\]/, /epChecklist\('p_coords', coords, \[\]/,
    /epChecklist\('ep_leads', leads, project\.teamLeadIds/,
    /epChecklist\('ep_coords', coords, project\.coordinatorIds/,
  ]) assert.match(PAGE, call, `a section is not going through the shared renderer: ${call}`);

  /* THE REGRESSION THE REFACTOR HAD TO NOT CAUSE: the three existing sections
     still render the same control and still send the same field names. */
  for (const field of ['teamLeadIds', 'coordinatorIds', 'supervisionIds']) {
    assert.ok(PAGE.includes(field), `${field} still travels`);
  }
  assert.match(PAGE, /#p_leads input:checked/);
  assert.match(PAGE, /#ep_leads input:checked/);
  assert.match(PAGE, /supervisionChecklist\('p_supervision'/, 'supervision keeps its own capped renderer');
});

test('the section sits after Team Leads, in both forms, and says who is eligible', () => {
  for (const [leads, acting] of [['p_leads', 'p_acting'], ['ep_leads', 'ep_acting']]) {
    const at = PAGE.indexOf(`id="${leads}"`);
    const after = PAGE.indexOf(`id="${acting}"`);
    const coords = PAGE.indexOf(`id="${leads.replace('leads', 'coords')}"`);
    assert.ok(at !== -1 && after !== -1 && coords !== -1);
    assert.ok(at < after && after < coords,
      `${acting} sits between the leads and the coordinators`);
  }
  assert.strictEqual((PAGE.match(/Any active user can be selected\./g) || []).length, 2,
    'the helper line is under both headings');
  /* THE PICKER IS EVERYBODY, which is the departure from the three beside it. */
  assert.match(PAGE, /api\('\/users\?limit=500'\)/);
});

test('MUTATION 5 (page half) — a Team Lead is offered disabled, with the reason', () => {
  const fn = PAGE.slice(PAGE.indexOf('function actingDisabledMap'), PAGE.indexOf('function wireActingSync'));
  assert.match(fn, /Already a Team Lead on this project/);
  const renderer = PAGE.slice(PAGE.indexOf('function epChecklist'), PAGE.indexOf('function actingDisabledMap'));
  assert.match(renderer, /disabled \? disabled\.get\(u\.id\) : null/);
  assert.match(renderer, /why\?' disabled':''/, 'the box is actually disabled');
  assert.match(renderer, /title="'\+escapeHTML\(why\)\+'"/, 'and the reason is its tooltip');
});

test('no native dialog is used by this feature', () => {
  const strip = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
  const section = strip(PAGE.slice(PAGE.indexOf('function epChecklist'), PAGE.indexOf('async function openEditProject')));
  for (const bad of [/\balert\s*\(/, /\bconfirm\s*\(/, /\bprompt\s*\(/]) {
    assert.ok(!bad.test(section), `a native dialog appears: ${bad}`);
  }
});

// ===========================================================================
// 3. THE AUTHORITY LABEL.
// ===========================================================================

test('MUTATION 7 and d — the label is only for somebody whose ONLY qualification is acting', () => {
  const src = SRC('permissions.js');
  const fn = src.slice(src.indexOf('async function tlGateAuthority'), src.indexOf('// Full access: the studio-wide tier.'));
  assert.match(fn, /via\.length === 1 && via\[0\] === ACTING_TABLE/,
    'one matching table, and it is the acting one');
  assert.match(fn, /return 'acting_team_lead'/);
  /* A PERSON WHO ALSO MATCHES ANOTHER TABLE KEEPS THEIR LABEL — asserted on the
     condition itself, because a mutant that dropped `via.length === 1` would
     relabel every Team Lead who had also been named as a stand-in. */
  assert.ok(!/via\.includes\(ACTING_TABLE\)/.test(fn),
    'membership alone must not be enough — it has to be the only one');

  /* AND THE WORDS REACH THE SCREEN. */
  assert.match(SRC('routes/assets.js'), /acting_team_lead: 'Acting TL'/);
  assert.match(SRC('routes/assets.js'), /actedViaLabel: ACTED_VIA_LABELS/);
  assert.match(PAGE, /e\.actedViaLabel \? ` <span class="hist-via">\(\$\{escapeHTML\(e\.actedViaLabel\)\}\)<\/span>` : ''/);
  /* 'team_lead' IS NOT LABELLED, on purpose: annotating every approval the
     studio has ever made would be new noise on old rows. */
  const labels = SRC('routes/assets.js');
  const block = labels.slice(labels.indexOf('const ACTED_VIA_LABELS'), labels.indexOf('};', labels.indexOf('const ACTED_VIA_LABELS')));
  assert.ok(!/\bteam_lead:/.test(block), 'the ordinary case stays unannotated');
});

// ===========================================================================
// 4. VISIBILITY: the rule that must not leak.
// ===========================================================================

test('MUTATION a — acting visibility is a union, not a clause inside two scopes', () => {
  const src = SRC('permissions.js');
  const fn = src.slice(src.indexOf('async function visibleProjects'), src.indexOf('// Which of these projects'));
  /* ONE RULE, APPLIED TO EVERY SCOPE BELOW 'all'. Written as a clause inside
     the 'assigned' and 'team' queries it would have left the two NARROWER
     scopes — 'owned' and 'own_work' — unable to see a project they had been put
     in charge of, which is exactly the designation a studio reaches for when it
     wants a stand-in. */
  assert.match(fn, /const withActing = async \(rows\) =>/);
  assert.strictEqual((fn.match(/return withActing\(rows\);/g) || []).length, 4,
    'all FOUR scopes below studio-wide go through it — owned, assigned, team and own_work. '
    + 'The last of those sits at the function\'s top level rather than inside an if, which is '
    + 'exactly how it was missed the first time: the narrowest scope, and the one that matters '
    + 'most, because it is the designation a studio names a stand-in from.');
  assert.ok(!/return rows;\s*\n\s*}\s*\n\s*\/\* ----/.test(fn.slice(fn.indexOf('withActing'))),
    'no scope returns its rows unwidened after the union exists');
  /* AND IT ADDS ONLY THE PROJECTS THEY ARE ACTING ON. */
  assert.match(fn, /WHERE patl\.user_id = \$1 AND p\.is_active = 1/);
  assert.match(fn, /acting\.filter\(\(p\) => !seen\.has\(p\.id\)\)/, 'de-duplicated, never multiplied');
});

// ===========================================================================
// 5. THE SUBMISSION AUDIENCE: added to, never replaced.
// ===========================================================================

test('MUTATION b and c — acting leads are added to the audience and nobody is removed', () => {
  const src = SRC('assignments.js');
  const fn = src.slice(src.indexOf('async function submissionAudience'), src.indexOf('module.exports'));
  /* THE THREE EXISTING RECIPIENTS ARE UNTOUCHED, and the assertions are on the
     lines that produce them: a mutant that replaced the audience rather than
     adding to it has to delete one of these. */
  assert.match(fn, /if \(row\.assignedBy\) ids\.add\(row\.assignedBy\);/);
  assert.match(fn, /else if \(row\.createdBy\) ids\.add\(row\.createdBy\);/);
  assert.match(fn, /if \(row\.teamLead\) ids\.add\(row\.teamLead\);/);
  /* AND THE ADDITION IS AN ADDITION: ids.add into the same Set, which is also
     what de-duplicates an acting lead who was already the assigner. */
  assert.match(fn, /for \(const row of acting\) if \(row\.userId\) ids\.add\(row\.userId\);/);
  assert.ok(!/ids\.clear\(\)|ids = new Set\(\)/.test(fn.slice(fn.indexOf('acting'))),
    'nothing resets the audience after the originals are in it');
  /* ONLY THE EVENTS THIS FUNCTION ALREADY COVERS — it is still one function
     with one caller shape, not a new notification path. */
  assert.strictEqual((SRC('email-notifications.js').match(/submissionAudience/g) || []).length, 1);
});

// ===========================================================================
// 6. WHAT THE CODEBASE DOES NOT HAVE.
// ===========================================================================

test('there is no project clone, import or export to extend', () => {
  /* REPORTED RATHER THAN BUILT. The brief asks for the section to be included
     "wherever the other sections are included" in duplication, import and
     export — and there is no such path: no duplicate/clone endpoint exists, the
     asset importer imports assets, and src/report-export.js exports timesheet
     and asset rows, naming a project only as a column. There is nothing to
     extend, and inventing a project-clone feature to have somewhere to add this
     to would be a far larger change than the one asked for. */
  const routes = SRC('routes/projects.js');
  /* Matched on a ROUTE or a function, not on the word: "de-duplicated" appears
     in the prose of this very file, and a test that failed on its own comments
     is a test nobody keeps. */
  for (const bad of [/router\.\w+\('[^']*(?:duplicate|clone|copy)/i,
    /function\s+(?:duplicate|clone|copy)Project/i]) {
    assert.ok(!bad.test(routes), `a project duplication path appeared — it now needs the acting list`);
  }
  const exporter = SRC('report-export.js');
  assert.ok(!/teamLeadIds|project_team_leads/.test(exporter),
    'the exporter does not carry project membership, so there is nothing to add beside');

  /* THE ONE PATH THAT DOES CREATE PROJECTS BESIDE THE ROUTE is the
     client-with-projects form, which names leads and coordinators only. It
     keeps working with no acting leads, which is the correct starting point —
     nobody has been asked yet. */
  assert.match(SRC('clients.js'), /\[\[teamLeadIds, 'project_team_leads'\], \[coordinatorIds, 'project_coordinators'\]\]/);
});

test('Edit User cannot touch an acting row', () => {
  /* user-project.js moves a person between the three tables its own TABLES
     constant names. The acting table is not one of them, so saving a user
     cannot delete or alter an acting row — asserted on the constant rather than
     on a behaviour, because that is where the property lives. */
  const src = SRC('user-project.js');
  assert.match(src, /const TABLES = \['project_coordinators', 'project_team_leads', 'project_members'\];/);
  assert.ok(!src.includes(TABLE), 'and it never names the acting table');
});

// ===========================================================================
// 7. END TO END.
//
// Through the real server, the real routes and a real database. The cast:
//
//   root    super admin, studio-wide
//   lead    a Team Lead by designation, named on project ALPHA
//   ana     a GAME ARTIST — projectScope 'own_work', the NARROWEST scope there
//           is — named Acting Team Lead on ALPHA and nothing else. The whole
//           feature is about what this person can and cannot do.
//   bo      another game artist, on nothing. The control.
//
// Two projects, ALPHA and BETA, so "sees that project and no others" is a
// question with a wrong answer available.
// ===========================================================================

test('acting team leads, end to end', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  let server;
  const token = {};
  const id = {};
  const as = (who, path, opts = {}) => api(server.base, path, { ...opts, token: token[who] });

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'acting-token',
      WORK_HOURS_SWEEP_MINUTES: '0',
      EMAIL_SWEEP_MS: '0',
      EMAIL_BATCH_MS: '0',
    });
    await api(server.base, '/auth/bootstrap', { method: 'POST',
      body: { token: 'acting-token', name: 'Root', email: 'root@at.test', password: PASSWORD } });
    const login = async (email) => (await api(server.base, '/auth/login', {
      method: 'POST', body: { email, password: PASSWORD } })).body.token;
    token.root = await login('root@at.test');
    id.root = (await api(server.base, '/auth/me', { token: token.root })).body.user.id;
    await openStudio(server.base, token.root);

    const make = async (key, name, email, role) => {
      const r = await as('root', '/users', { method: 'POST', body: { name, email, password: PASSWORD, role } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      id[key] = r.body.user.id;
      token[key] = await login(email);
    };
    await make('lead', 'Lee Lead', 'lee@at.test', 'team_lead');
    await make('ana', 'Ana Artist', 'ana@at.test', 'game_artist');
    await make('bo', 'Bo Artist', 'bo@at.test', 'game_artist');
    /* THE PREMISE OF THE WHOLE SUITE, asserted rather than assumed: Ana's
       designation is the narrowest scope the application has. */
    assert.strictEqual(roleDef('game_artist').projectScope, 'own_work');

    id.client = await systemClientId(server.base, token.root);
    const mkProject = async (key, name, body = {}) => {
      const r = await as('root', '/projects', { method: 'POST',
        body: { name, clientId: id.client, ...body } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      id[key] = r.body.project.id;
    };
    await mkProject('alpha', 'Alpha', { teamLeadIds: [id.lead], actingTeamLeadIds: [id.ana] });
    await mkProject('beta', 'Beta', { teamLeadIds: [id.lead] });
  });

  t.after(() => stopServer(server));

  const projectOf = async (key) => (await as('root', `/projects/${id[key]}`)).body.project;
  const visible = async (who) => ((await as(who, '/projects')).body.projects || []).map((p) => p.name).sort();

  await t.test('created with the section, stored and returned', async () => {
    const alpha = await projectOf('alpha');
    assert.deepStrictEqual(alpha.actingTeamLeadIds, [id.ana]);
    assert.deepStrictEqual(alpha.teamLeadIds, [id.lead], 'and the existing section is untouched');
    const beta = await projectOf('beta');
    assert.deepStrictEqual(beta.actingTeamLeadIds, [], 'a project created without one has none');
  });

  await t.test('ruling 3 — the narrowest scope sees that project AND NO OTHERS', async () => {
    /* THE ASSERTION THE WHOLE FEATURE TURNS ON. Ana is a game artist with no
       work anywhere; without the acting row she would see nothing at all. */
    assert.deepStrictEqual(await visible('ana'), ['Alpha']);
    assert.deepStrictEqual(await visible('bo'), [], 'the control sees nothing');
    /* And it did not widen anybody else. */
    assert.deepStrictEqual(await visible('lead'), ['Alpha', 'Beta']);
  });

  await t.test('ruling 3b — their role and permissions are unchanged', async () => {
    const me = (await as('ana', '/auth/me')).body.user;
    assert.strictEqual(me.role, 'game_artist', 'the designation is untouched');
    const control = (await as('bo', '/auth/me')).body.user;
    assert.ok(Array.isArray(me.permissions) && me.permissions.length,
      'the endpoint carries the resolved list');
    assert.deepStrictEqual(
      [...me.permissions].sort(), [...control.permissions].sort(),
      'and they hold exactly what every other game artist holds — being a stand-in '
      + 'on one project grants no permission');
  });

  await t.test('they can act at the TL gate on that project, and not on the other', async () => {
    const mkAsset = async (key, projectKey) => {
      const r = await as('root', `/assets/project/${id[projectKey]}`, {
        method: 'POST', body: { name: `Hero ${key}`, type: 'character' } });
      assert.strictEqual(r.status, 201, JSON.stringify(r.body));
      id[key] = r.body.asset.id;
    };
    await mkAsset('aAlpha', 'alpha');
    await mkAsset('aBeta', 'beta');
    for (const [asset, who] of [['aAlpha', 'bo'], ['aBeta', 'bo']]) {
      await as('root', `/assets/${id[asset]}`, { method: 'PATCH', body: { assigneeId: id[who] } });
      await as(who, `/assets/${id[asset]}/start`, { method: 'POST', body: {} });
      const sub = await as(who, `/assets/${id[asset]}/submit`, { method: 'POST', body: { link: 'http://x/1' } });
      assert.ok(sub.status < 400, JSON.stringify(sub.body));
    }

    const onAlpha = await as('ana', `/assets/${id.aAlpha}/review`, { method: 'POST', body: { decision: 'approved' } });
    assert.ok(onAlpha.status < 400, `Ana may review on Alpha: ${JSON.stringify(onAlpha.body)}`);

    const onBeta = await as('ana', `/assets/${id.aBeta}/review`, { method: 'POST', body: { decision: 'approved' } });
    assert.ok(onBeta.status >= 400, 'and may not on Beta');
  });

  await t.test('ruling 6 — the history says in what capacity they acted', async () => {
    const hist = await as('root', `/assets/${id.aAlpha}/history`);
    assert.strictEqual(hist.status, 200, JSON.stringify(hist.body));
    const mine = hist.body.events.filter((e) => e.actorId === id.ana);
    assert.ok(mine.length, 'Ana is in the history');
    assert.ok(mine.some((e) => e.actedVia === 'acting_team_lead'),
      `the capacity was recorded: ${JSON.stringify(mine.map((e) => e.actedVia))}`);
    assert.ok(mine.some((e) => e.actedViaLabel === 'Acting TL'), 'and the words reach the screen');

    /* MUTATION d — THE DESIGNATED LEAD IS NOT RELABELLED. Lee is a Team Lead on
       Alpha and not on the acting list, so nothing about them changes. */
    const theirs = hist.body.events.filter((e) => e.actorId === id.lead);
    assert.ok(theirs.every((e) => e.actedVia !== 'acting_team_lead'));
  });

  await t.test('ruling 4 — acting leads are ADDED to the submission audience', async () => {
    /* The audience is the reporting line: who assigned it, who created it, the
       submitter's own lead. Ana is none of those on Alpha — she is only the
       acting lead — so a notification reaching her is the addition, and the
       assigner still being notified is the "nobody is removed" half. */
    const r = await as('root', `/assets/project/${id.alpha}`, {
      method: 'POST', body: { name: 'Audience', type: 'character' } });
    const asset = r.body.asset.id;
    await as('root', `/assets/${asset}`, { method: 'PATCH', body: { assigneeId: id.bo } });
    await as('bo', `/assets/${asset}/start`, { method: 'POST', body: {} });
    await as('bo', `/assets/${asset}/submit`, { method: 'POST', body: { link: 'http://x/2' } });

    const told = await sql(cfg,
      "SELECT recipient_id FROM notifications WHERE asset_id = ? AND kind = 'submitted'", [asset]);
    const ids = told.map((n) => n.recipient_id);
    assert.ok(ids.includes(id.ana), 'the acting lead was told');
    assert.strictEqual(ids.filter((x) => x === id.ana).length, 1, 'once, not twice');
    assert.ok(ids.includes(id.root), 'and whoever assigned it still is — nobody was replaced');
    assert.ok(!ids.includes(id.bo), 'the submitter is never in their own audience');
  });

  await t.test('ruling 5 — the same person cannot be both, and the server says 409', async () => {
    const clash = await as('root', `/projects/${id.alpha}`, { method: 'PATCH',
      body: { teamLeadIds: [id.lead, id.ana], actingTeamLeadIds: [id.ana] } });
    assert.strictEqual(clash.status, 409, JSON.stringify(clash.body));
    assert.match(clash.body.error, /already a Team Lead on this project/);

    /* AND A SWAP IS NOT A CLASH: taking somebody out of Team Leads and putting
       them in Acting in one save is a legitimate edit, and refusing it would
       have been the obvious wrong implementation. */
    const swap = await as('root', `/projects/${id.beta}`, { method: 'PATCH',
      body: { teamLeadIds: [], actingTeamLeadIds: [id.lead] } });
    assert.strictEqual(swap.status, 200, JSON.stringify(swap.body));
    assert.deepStrictEqual((await projectOf('beta')).actingTeamLeadIds, [id.lead]);
    await as('root', `/projects/${id.beta}`, { method: 'PATCH',
      body: { teamLeadIds: [id.lead], actingTeamLeadIds: [] } });
  });

  await t.test('MUTATION 9 — an inactive user cannot be named', async () => {
    await as('root', `/users/${id.bo}/deactivate`, { method: 'POST', body: {} });
    const r = await as('root', `/projects/${id.beta}`, { method: 'PATCH',
      body: { actingTeamLeadIds: [id.bo] } });
    assert.strictEqual(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /not an active account/);
    await as('root', `/users/${id.bo}/reactivate`, { method: 'POST', body: {} }).catch(() => {});
  });

  await t.test('ruling 8 — saving a user never touches an acting row', async () => {
    const before = await sql(cfg, `SELECT project_id FROM ${TABLE} WHERE user_id = ?`, [id.ana]);
    assert.strictEqual(before.length, 1);
    const r = await as('root', `/users/${id.ana}`, { method: 'PATCH', body: { projectId: id.beta } });
    assert.ok(r.status < 400, JSON.stringify(r.body));
    const after = await sql(cfg, `SELECT project_id FROM ${TABLE} WHERE user_id = ?`, [id.ana]);
    assert.deepStrictEqual(after.map((x) => x.project_id), before.map((x) => x.project_id),
      'the Edit User project field moves them between its own three tables and leaves this one alone');
  });

  await t.test('ruling 10 — removal takes the project and the gate away again', async () => {
    const gone = await as('root', `/projects/${id.alpha}`, { method: 'PATCH',
      body: { actingTeamLeadIds: [] } });
    assert.strictEqual(gone.status, 200, JSON.stringify(gone.body));
    assert.deepStrictEqual((await projectOf('alpha')).actingTeamLeadIds, []);

    /* Ana was put on Beta as a project MEMBER by the previous case, so what
       she can see now is Beta and not Alpha — which is the removal working,
       and is a sharper assertion than "sees nothing". */
    assert.ok(!(await visible('ana')).includes('Alpha'), 'Alpha is out of view again');

    /* AND THE GATE IS SHUT AGAIN. Asserted by trying to use it rather than by
       reading an asset: there is no GET /assets/:id in this application — the
       board fetches lists — so a 404 from a route that does not exist would
       have proved nothing. */
    const r = await as('root', `/assets/project/${id.alpha}`, {
      method: 'POST', body: { name: 'After', type: 'character' } });
    const asset = r.body.asset.id;
    await as('root', `/assets/${asset}`, { method: 'PATCH', body: { assigneeId: id.bo } });
    await as('bo', `/assets/${asset}/start`, { method: 'POST', body: {} });
    await as('bo', `/assets/${asset}/submit`, { method: 'POST', body: { link: 'http://x/4' } });
    const refused = await as('ana', `/assets/${asset}/review`, { method: 'POST', body: { decision: 'approved' } });
    assert.ok(refused.status >= 400, 'and they can no longer act at its review gate');
  });

  await t.test('ruling 10b — with no lead left, the project falls back exactly as before', async () => {
    /* Alpha still has its designated Team Lead, so take that away too and read
       what the application does: projectHasReviewTeam() goes false and the gate
       returns to the pre-team path. That behaviour is not changed by this
       feature, and this is the assertion that says so. */
    await as('root', `/projects/${id.alpha}`, { method: 'PATCH', body: { teamLeadIds: [] } });
    const alpha = await projectOf('alpha');
    assert.deepStrictEqual(alpha.teamLeadIds, []);
    assert.deepStrictEqual(alpha.actingTeamLeadIds, []);
    /* The Super Admin can still act — full access reaches every gate staffed or
       not, which is what "unchanged" means here. */
    const r = await as('root', `/assets/project/${id.alpha}`, {
      method: 'POST', body: { name: 'NoLead', type: 'character' } });
    const asset = r.body.asset.id;
    await as('root', `/assets/${asset}`, { method: 'PATCH', body: { assigneeId: id.bo } });
    await as('bo', `/assets/${asset}/start`, { method: 'POST', body: {} });
    const sub = await as('bo', `/assets/${asset}/submit`, { method: 'POST', body: { link: 'http://x/3' } });
    assert.ok(sub.status < 400, JSON.stringify(sub.body));
    const review = await as('root', `/assets/${asset}/review`, { method: 'POST', body: { decision: 'approved' } });
    assert.ok(review.status < 400, `the unstaffed fallback still works: ${JSON.stringify(review.body)}`);
  });

  await t.test('ruling 11 — the client-with-projects path works with no acting leads', async () => {
    const r = await as('root', '/clients', { method: 'POST', body: {
      name: 'Acme Acting', projects: [{ name: 'Gamma', teamLeadIds: [id.lead], coordinatorIds: [] }] } });
    assert.ok(r.status < 400, JSON.stringify(r.body));
    const made = (await as('root', '/projects')).body.projects.find((p) => p.name === 'Gamma');
    assert.ok(made, 'the project was created');
    const full = (await as('root', `/projects/${made.id}`)).body.project;
    assert.deepStrictEqual(full.actingTeamLeadIds, [],
      'created through a path that never mentions the section, and it is simply empty');
  });

  await t.test('ruling 9 — projectHasReviewTeam counts inactive members today', async () => {
    /* REPORTED, NOT CHANGED. Membership rows survive deactivation and the
       review-team queries do not join users, so a project whose only named lead
       has left still "has a review team" and does not fall back. That is
       today's behaviour for all four lists, including the three that predate
       this change, and altering it here would change the gate for every project
       in the studio. */
    const src = SRC('permissions.js');
    const fn = src.slice(src.indexOf('async function projectsWithReviewTeam'), src.indexOf('async function projectHasReviewTeam'));
    assert.ok(!/is_active/.test(fn), 'the review-team query does not look at is_active');
    assert.ok(!/JOIN users/.test(fn), 'nor does it join users at all');
  });
});

test('the gated actions are exactly the ones the workflow puts behind that gate', () => {
  /* DERIVED FROM THE TRANSITION TABLE, not from memory. TL_GATED decides which
     transitions record what got somebody through the first review gate, and a
     list that drifted from the workflow's own `who` would either annotate a
     move nobody reviews or leave an Acting TL's approval unlabelled. */
  const wf = SRC('asset-workflow.js');
  /* Each transition is a block beginning `action: '…'`; the one that follows it
     ends where the next begins. Sliced that way rather than parsed, because the
     table is a literal and a regex over the whole file would pair an action
     with a `who` several entries away. */
  const gated = new Set();
  const starts = [...wf.matchAll(/\n\s*action: '([a-z_]+)'/g)];
  for (let i = 0; i < starts.length; i += 1) {
    const from = starts[i].index;
    const to = i + 1 < starts.length ? starts[i + 1].index : wf.length;
    if (/who: '(teamLead|gameFeedbackLead)'/.test(wf.slice(from, to))) gated.add(starts[i][1]);
  }
  assert.ok(gated.size >= 6, `found ${gated.size} gated transitions in the table`);
  const assets = SRC('routes/assets.js');
  const declared = new Set(
    (assets.slice(assets.indexOf('const TL_GATED'), assets.indexOf('const ACTED_VIA_LABELS'))
      .match(/'[a-z_]+'/g) || []).map((q) => q.slice(1, -1))
  );
  assert.deepStrictEqual([...declared].sort(), [...gated].sort(),
    'TL_GATED and the workflow table disagree about which moves go through the review gate');
});
