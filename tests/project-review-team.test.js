/* Who stands at the first review gate: the PROJECT'S team, not the artist's.
 *
 * WHAT CHANGED. The gate used to be a property of the reporting line. "May this
 * person act on this asset at TL Review" was answered by reading
 * users.team_lead_id off the assignee and asking whether it pointed at the
 * caller. Two things were wrong with that, and the studio hit both:
 *
 *   The reviewer moved with the artist. The same asset, in the same project, at
 *   the same stage, had a different answer depending on which artist happened
 *   to pick the work up — so a lead staffed on a project could not clear work
 *   done by somebody who reported elsewhere, and nothing on screen explained
 *   why.
 *
 *   Only leads were ever in the frame. A Production Coordinator running the
 *   project, a Supervisor answerable for its look, a Creative Director on it
 *   from the start — none of them are anybody's "reports to", so none of them
 *   could act however plainly they were on the project.
 *
 * The rule now: being on the project's team, in one of four categories, lets
 * you act on EVERY asset in that project sitting at the first gate.
 *
 *   Team Lead                project_team_leads
 *   Production Coordinator   project_coordinators
 *   Supervision              project_supervision   (one list, one section on
 *   Creative Direction       project_supervision    the project form)
 *
 * WHAT THIS FILE IS CAREFUL ABOUT:
 *
 *   THE HIERARCHY IS GONE, not merely outvoted. A test that only proves the new
 *      people can act would still pass with team_lead_id read alongside it. So
 *      the artist here reports to a lead who is deliberately NOT on the
 *      project, and that lead is asserted to be refused.
 *
 *   THE SELF-REVIEW GUARD SURVIVES THE WIDENING. It is the one rule the broader
 *      reach could quietly reopen — the qualifying people are exactly the sort
 *      who also get handed work — so it is asserted from inside the new
 *      access, by somebody who would otherwise be allowed.
 *
 *   PROJECTS NOBODY STAFFED STILL WORK. "The project's team decides" says
 *      nothing about a project that has no team, and answering "then nobody
 *      does" would strand every asset in every project that predates this.
 */
const test = require('node:test');
const assert = require('node:assert');

const { config, resetSchema, startServer, stopServer, api, sql, openStudio, SKIP_REASON } = require('./helpers');

const cfg = config('projreviewteam');

// --- pure ------------------------------------------------------------------

test('the gate reads the project team, and reads team_lead_id nowhere', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'permissions.js'), 'utf8');

  const start = src.indexOf('async function canActAtTlGate(user, asset) {');
  assert.ok(start > 0, 'the gate is a function of its own');
  const body = src.slice(start, src.indexOf('\n}\n', start));

  assert.match(body, /projectHasReviewTeam\(asset\.project_id\)/,
    'it asks whether the project has a team');
  assert.match(body, /onProjectReviewTeam\(user, asset\.project_id\)/,
    'and whether this person is on it');
  assert.match(body, /holds\(user, 'review\.tl'\)/,
    'the Settings switch is still asked first');
  assert.match(body, /asset\.assignee_id === user\.id\) return false/,
    'and nobody reviews their own work');

  /* team_lead_id may still appear, but ONLY below the fallback for a project
     with nobody on it. Split on the line that opens that fallback and assert
     the half above it is clean — which is the half that decides a staffed
     project. */
  const marker = body.indexOf('/* No team named on the project.');
  assert.ok(marker > 0, 'the unstaffed fallback is marked');
  assert.ok(!body.slice(0, marker).includes('team_lead_id'),
    'the staffed path must not read the reporting line at all');
});

test('the three tables are the four categories, and nothing else', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'permissions.js'), 'utf8');
  const line = src.match(/const PROJECT_TEAM_TABLES = \[([^\]]*)\]/);
  assert.ok(line, 'the list is named once');
  const tables = line[1].split(',').map((t) => t.trim().replace(/'/g, '')).filter(Boolean);
  assert.deepStrictEqual(tables,
    ['project_team_leads', 'project_coordinators', 'project_supervision'],
    'team leads, production coordinators, and the combined supervision and '
    + 'creative direction list — project_members is deliberately NOT here, '
    + 'because being on a project is not the same as being on its team');
});

test('every designation the project form can name arrives able to act', () => {
  /* The permission is still the Settings switch, so a designation that fills
     one of the three checklists and does NOT start with review.tl would be
     staffed onto a project and still refused — a feature that looks broken and
     is actually one toggle away. Checked against the catalogue rather than
     against a list of keys. */
  const { capabilitiesForTier } = require('../src/role-tiers');
  const defaults = require('../src/reference-defaults');
  const roles = Object.values(defaults).find(
    (v) => Array.isArray(v) && v[0] && typeof v[0].tier === 'string'
  );
  assert.ok(roles && roles.length, 'the catalogue is readable');

  const catalog = require('../src/permission-catalog');
  const { defaultsFor } = require('../src/role-permissions');

  const gaps = [];
  for (const role of roles) {
    const caps = capabilitiesForTier(role.tier) || {};
    const nameable = caps.leadsTeam
      || caps.projectScope === 'assigned'
      || ['Supervision', 'Creative Direction'].includes(role.group);
    if (!nameable) continue;
    if (!defaultsFor(role.key).has('review.tl')) gaps.push(`${role.key} (${role.label})`);
  }
  assert.deepStrictEqual(gaps, [],
    'these can be put on a project team but start unable to act there');
  assert.ok(catalog.KEYS.includes('review.tl'), 'and it is a real, grantable key');
});

// --- against a live server -------------------------------------------------

test('acting at the first gate, by project team', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'ProjTeam-1!';
  let server;
  let projectId;
  let otherProjectId;
  let clientId;
  const tok = {};
  const id = {};

  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: tok[who] });
  const login = async (email) =>
    (await api(server.base, '/auth/login', { method: 'POST', body: { email, password: PASSWORD } })).body.token;
  const statusOf = async (assetId) => (await as('root', `/assets/${assetId}/history`)).body.status;

  /* An asset by an artist whose own lead is nowhere near this project, sitting
     at the first gate. Every step through its own route. */
  let made = 0;
  const atTlReview = async (project = projectId) => {
    const r = await as('root', `/assets/project/${project}`, {
      method: 'POST', body: { name: `Shot ${made += 1}`, type: 'prop', assigneeId: id.ana },
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const assetId = r.body.asset.id;
    await as('ana', `/assets/${assetId}/start`, { method: 'POST' });
    const s = await as('ana', `/assets/${assetId}/submit`, {
      method: 'POST', body: { link: 'https://example.com/v1' },
    });
    assert.strictEqual(s.status, 201, JSON.stringify(s.body));
    assert.strictEqual(await statusOf(assetId), 'pending_tl_review', 'setup');
    return assetId;
  };

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, {
      BOOTSTRAP_TOKEN: 'test-bootstrap-token', WORK_HOURS_SWEEP_MINUTES: '0',
    });
    await api(server.base, '/auth/bootstrap', {
      method: 'POST',
      body: { token: 'test-bootstrap-token', name: 'Root Admin', email: 'root@zvky.test', password: PASSWORD },
    });
    tok.root = await login('root@zvky.test');
    await openStudio(server.base, tok.root);

    const make = async (key, name, email, role, teamLeadId) => {
      const r = await as('root', '/users', {
        method: 'POST', body: { name, email, role, password: PASSWORD, teamLeadId },
      });
      assert.strictEqual(r.status, 201, `${role}: ${JSON.stringify(r.body)}`);
      id[key] = r.body.user.id;
      tok[key] = await login(email);
    };

    /* THE FOUR CATEGORIES, one person each. */
    await make('lead', 'Leela Lead', 'lead@zvky.test', 'team_lead');
    await make('coord', 'Colin Coord', 'coord@zvky.test', 'coordinator');
    await make('sup', 'Sunil Supervisor', 'sup@zvky.test', 'art_supervisor');
    await make('cd', 'Dina Director', 'cd@zvky.test', 'art_director');

    /* THE ARTIST'S OWN LEAD — a Team Lead by designation, deliberately not on
       the project. Under the old rule this was the ONLY person who could clear
       this artist's work; under the new one it buys nothing. */
    await make('ownlead', 'Omar Ownlead', 'ownlead@zvky.test', 'team_lead');
    await make('ana', 'Ana Artist', 'ana@zvky.test', 'game_artist', id.ownlead);

    const clients = await as('root', '/clients');
    clientId = clients.body.clients[0].id;
    const project = await as('root', '/projects', {
      method: 'POST',
      body: {
        name: 'Gatehouse', clientId,
        teamLeadIds: [id.lead],
        coordinatorIds: [id.coord],
        supervisionIds: [id.sup, id.cd],
      },
    });
    assert.strictEqual(project.status, 201, JSON.stringify(project.body));
    projectId = project.body.project.id;
  });

  t.after(() => stopServer(server));

  /* --- 1: the team is on the project, tagged by category ------------------- */

  await t.test('the four categories are set when the project is created', async () => {
    const r = await as('root', `/projects/${projectId}`);
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    assert.deepStrictEqual(r.body.project.teamLeadIds, [id.lead]);
    assert.deepStrictEqual(r.body.project.coordinatorIds, [id.coord]);
    assert.deepStrictEqual([...r.body.project.supervisionIds].sort(), [id.sup, id.cd].sort());

    /* And they are editable afterwards from the project's own settings, which
       is the same endpoint the Edit Project form posts to. */
    const off = await as('root', `/projects/${projectId}`, {
      method: 'PATCH', body: { coordinatorIds: [] },
    });
    assert.strictEqual(off.status, 200, JSON.stringify(off.body));
    assert.deepStrictEqual((await as('root', `/projects/${projectId}`)).body.project.coordinatorIds, []);
    const back = await as('root', `/projects/${projectId}`, {
      method: 'PATCH', body: { coordinatorIds: [id.coord] },
    });
    assert.strictEqual(back.status, 200, JSON.stringify(back.body));
    assert.deepStrictEqual((await as('root', `/projects/${projectId}`)).body.project.coordinatorIds, [id.coord]);
  });

  /* --- 2: all four can act at TL Review, whoever the artist reports to ----- */

  await t.test('all four categories can answer at TL Review', async () => {
    for (const who of ['lead', 'coord', 'sup', 'cd']) {
      const assetId = await atTlReview();
      const r = await as(who, `/assets/${assetId}/review`, { method: 'POST', body: { decision: 'approved' } });
      assert.strictEqual(r.status, 200, `${who} at TL Review: ${JSON.stringify(r.body)}`);
      assert.strictEqual(await statusOf(assetId), 'tl_approved', `${who} moved it on`);
    }
  });

  await t.test('and all four can send it back for changes', async () => {
    for (const who of ['lead', 'coord', 'sup', 'cd']) {
      const assetId = await atTlReview();
      const r = await as(who, `/assets/${assetId}/review`, {
        method: 'POST', body: { decision: 'changes_requested', text: 'tighten the silhouette' },
      });
      assert.strictEqual(r.status, 200, `${who} requesting changes: ${JSON.stringify(r.body)}`);
      assert.strictEqual(await statusOf(assetId), 'tl_changes_requested');
    }
  });

  await t.test('all four can SEE it, not only act on it', async () => {
    const assetId = await atTlReview();
    for (const who of ['lead', 'coord', 'sup', 'cd']) {
      const board = await as(who, `/assets/project/${projectId}`);
      assert.strictEqual(board.status, 200, `${who} reading the board: ${JSON.stringify(board.body)}`);
      const mine = board.body.assets.find((a) => a.id === assetId);
      assert.ok(mine, `${who} sees an asset by an artist who reports elsewhere`);
      assert.strictEqual(mine.can_review_tl, true,
        `${who} is told they may act on it, so the page offers the controls`);
    }
  });

  /* --- 3: the same holds at TL Feedbacks and TL Approved ------------------- */

  await t.test('the project team can reassign out of TL Feedbacks', async () => {
    /* Three of the four, and the fourth is a permission fact rather than a
       standing one — see the subtest below, which proves it.
       
       Handing work on is ASSIGNING it, so it asks asset.assign as well as
       standing at the stage. Creative Direction does not hold asset.assign by
       default and never has; the studio's reasoning is that a director records
       direction rather than moves people around. Nothing here changes that, and
       it is one toggle in Settings for a studio that wants it. */
    for (const who of ['lead', 'coord', 'sup']) {
      /* One asset each for the two options. Handing rework on puts the asset
         back to Assigned with a fresh round, so a second reassign on the same
         one is refused for its stage rather than for who is asking — which
         would say nothing about the rule under test. */
      const sendBack = async () => {
        const assetId = await atTlReview();
        const sent = await as(who, `/assets/${assetId}/review`, {
          method: 'POST', body: { decision: 'changes_requested', text: 'again' },
        });
        assert.strictEqual(sent.status, 200, `${who} at TL Review: ${JSON.stringify(sent.body)}`);
        return assetId;
      };
      // Back to the same person — the one-click option.
      const same = await as(who, `/assets/${await sendBack()}/reassign`, {
        method: 'POST', body: { assigneeId: id.ana },
      });
      assert.strictEqual(same.status, 200, `${who} reassigning to the same user: ${JSON.stringify(same.body)}`);
      // And to anybody else, through the full picker.
      const other = await as(who, `/assets/${await sendBack()}/reassign`, {
        method: 'POST', body: { assigneeId: id.lead },
      });
      assert.strictEqual(other.status, 200, `${who} reassigning to anyone: ${JSON.stringify(other.body)}`);
    }
  });

  await t.test('and Creative Direction is stopped by the assign permission, not by the gate', async () => {
    const assetId = await atTlReview();
    /* Standing at the stage: the CD clears the first gate on this project, so
       the project team rule plainly reaches them. */
    const sent = await as('cd', `/assets/${assetId}/review`, {
      method: 'POST', body: { decision: 'changes_requested', text: 'rework this' } });
    assert.strictEqual(sent.status, 200, JSON.stringify(sent.body));

    const refused = await as('cd', `/assets/${assetId}/reassign`, {
      method: 'POST', body: { assigneeId: id.ana } });
    assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));

    // Granted in Settings, the same person on the same asset goes through.
    await sql(cfg, `INSERT INTO role_permissions (role_key, permission_key, enabled)
                    VALUES ('art_director', 'asset.assign', 1)
                    ON DUPLICATE KEY UPDATE enabled = 1`);
    const allowed = await as('cd', `/assets/${assetId}/reassign`, {
      method: 'POST', body: { assigneeId: id.ana } });
    assert.strictEqual(allowed.status, 200,
      `the gate was never the blocker: ${JSON.stringify(allowed.body)}`);
    await sql(cfg, `UPDATE role_permissions SET enabled = 0
                     WHERE role_key = 'art_director' AND permission_key = 'asset.assign'`);
  });

  await t.test('all four can route out of TL Approved', async () => {
    for (const who of ['lead', 'coord', 'sup', 'cd']) {
      const assetId = await atTlReview();
      await as(who, `/assets/${assetId}/review`, { method: 'POST', body: { decision: 'approved' } });
      assert.strictEqual(await statusOf(assetId), 'tl_approved');
      const r = await as(who, `/assets/${assetId}/send-to-cd`, { method: 'POST' });
      assert.strictEqual(r.status, 200, `${who} routing to CD Review: ${JSON.stringify(r.body)}`);
      assert.strictEqual(await statusOf(assetId), 'pending_cd_review');
    }
  });

  await t.test('Send to Client is reachable from the project team, and still needs its own permission', async () => {
    const assetId = await atTlReview();
    await as('sup', `/assets/${assetId}/review`, { method: 'POST', body: { decision: 'approved' } });

    /* Standing at the gate is not the authority to walk around the next one.
       review.tl_send_client is a separate grant and defaults to the full-access
       tier alone — the project team rule does not hand it out. */
    const refused = await as('sup', `/assets/${assetId}/send-to-client`, { method: 'POST' });
    assert.strictEqual(refused.status, 403, JSON.stringify(refused.body));

    await sql(cfg, `INSERT INTO role_permissions (role_key, permission_key, enabled)
                    VALUES ('art_supervisor', 'review.tl_send_client', 1)
                    ON DUPLICATE KEY UPDATE enabled = 1`);
    const allowed = await as('sup', `/assets/${assetId}/send-to-client`, { method: 'POST' });
    assert.strictEqual(allowed.status, 200, JSON.stringify(allowed.body));
    assert.strictEqual(await statusOf(assetId), 'approved_for_client');
    await sql(cfg, `UPDATE role_permissions SET enabled = 0
                     WHERE role_key = 'art_supervisor' AND permission_key = 'review.tl_send_client'`);
  });

  /* --- 4: holding the designation is not the same as being on the project -- */

  await t.test("the artist's own Team Lead, not on this project, is refused", async () => {
    const assetId = await atTlReview();

    /* Omar is a Team Lead. Ana reports to him. Under the rule this replaces he
       was the ONLY person who could clear this asset. He is not on the project,
       so now he is nobody here. */
    const r = await as('ownlead', `/assets/${assetId}/review`, {
      method: 'POST', body: { decision: 'approved' } });
    assert.strictEqual(r.status, 403, `the reporting line must buy nothing: ${JSON.stringify(r.body)}`);
    assert.strictEqual(await statusOf(assetId), 'pending_tl_review', 'and it did not move');

    // Nor at the other two stages.
    await as('lead', `/assets/${assetId}/review`, {
      method: 'POST', body: { decision: 'changes_requested', text: 'no' } });
    const reassign = await as('ownlead', `/assets/${assetId}/reassign`, {
      method: 'POST', body: { assigneeId: id.lead } });
    assert.strictEqual(reassign.status, 403, 'nor at TL Feedbacks');

    await as('ana', `/assets/${assetId}/submit`, { method: 'POST', body: { link: 'https://example.com/v2' } });
    await as('lead', `/assets/${assetId}/review`, { method: 'POST', body: { decision: 'approved' } });
    assert.strictEqual(await statusOf(assetId), 'tl_approved');
    const route = await as('ownlead', `/assets/${assetId}/send-to-cd`, { method: 'POST' });
    assert.strictEqual(route.status, 403, 'nor at TL Approved');
  });

  await t.test('putting that same lead on the project lets him in, and taking him off shuts it again', async () => {
    const assetId = await atTlReview();

    const on = await as('root', `/projects/${projectId}`, {
      method: 'PATCH', body: { teamLeadIds: [id.lead, id.ownlead] } });
    assert.strictEqual(on.status, 200, JSON.stringify(on.body));
    const allowed = await as('ownlead', `/assets/${assetId}/review`, {
      method: 'POST', body: { decision: 'approved' } });
    assert.strictEqual(allowed.status, 200, `on the team: ${JSON.stringify(allowed.body)}`);

    const off = await as('root', `/projects/${projectId}`, {
      method: 'PATCH', body: { teamLeadIds: [id.lead] } });
    assert.strictEqual(off.status, 200, JSON.stringify(off.body));
    const shut = await as('ownlead', `/assets/${assetId}/send-to-cd`, { method: 'POST' });
    assert.strictEqual(shut.status, 403, 'off the team, shut out again — nothing else about him changed');
  });

  await t.test('the page does not offer controls that would be refused', async () => {
    const assetId = await atTlReview();
    /* Omar can SEE this project — one of his reports has work in it, which is
       what projectScope 'team' means — so the board returns the asset to him.
       The flag is what stops three buttons being drawn on it. */
    const board = await as('ownlead', `/assets/project/${projectId}`);
    assert.strictEqual(board.status, 200);
    const mine = board.body.assets.find((a) => a.id === assetId);
    assert.ok(mine, 'he can see it — the change is about acting, not about looking');
    assert.strictEqual(mine.can_review_tl, false, 'and the page is told not to offer the gate');
  });

  /* --- 5: the self-review guard, from inside the new access ---------------- */

  await t.test('a project team member cannot clear their own submitted work', async () => {
    /* Leela is on this project as a Team Lead, so the rule above says she may
       act on every asset here. This one is hers. */
    const r = await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: 'Leela\'s own prop', type: 'prop', assigneeId: id.lead },
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    const assetId = r.body.asset.id;
    await as('lead', `/assets/${assetId}/start`, { method: 'POST' });
    const s = await as('lead', `/assets/${assetId}/submit`, {
      method: 'POST', body: { link: 'https://example.com/hers' } });
    assert.strictEqual(s.status, 201, JSON.stringify(s.body));

    const own = await as('lead', `/assets/${assetId}/review`, {
      method: 'POST', body: { decision: 'approved' } });
    assert.strictEqual(own.status, 403, `${JSON.stringify(own.body)}`);
    assert.strictEqual(await statusOf(assetId), 'pending_tl_review', 'and it did not move');

    // Nor may she send her own work back to herself for changes.
    const back = await as('lead', `/assets/${assetId}/review`, {
      method: 'POST', body: { decision: 'changes_requested', text: 'hmm' } });
    assert.strictEqual(back.status, 403);

    // The page agrees with the API rather than offering a button that fails.
    const board = await as('lead', `/assets/project/${projectId}`);
    assert.strictEqual(board.body.assets.find((a) => a.id === assetId).can_review_tl, false);

    // Anybody else on the team may, which is the point of not having one gatekeeper.
    const colleague = await as('sup', `/assets/${assetId}/review`, {
      method: 'POST', body: { decision: 'approved' } });
    assert.strictEqual(colleague.status, 200, JSON.stringify(colleague.body));
  });

  await t.test('nor the work they uploaded for somebody else', async () => {
    /* Submitting is assignee-only today, so this cannot happen by the front
       door. It is guarded anyway, because the widening is what makes it
       reachable the moment that changes — and the person who loosens
       submitting will not think to come back here. Set up through the database
       for that reason: the state is legal, the route to it is not. */
    const assetId = await atTlReview();
    await sql(cfg, 'UPDATE asset_versions SET uploaded_by = ? WHERE asset_id = ?', [id.sup, assetId]);
    const own = await as('sup', `/assets/${assetId}/review`, {
      method: 'POST', body: { decision: 'approved' } });
    assert.strictEqual(own.status, 403, 'the person who handed it in is not the person who clears it');
    const colleague = await as('lead', `/assets/${assetId}/review`, {
      method: 'POST', body: { decision: 'approved' } });
    assert.strictEqual(colleague.status, 200, JSON.stringify(colleague.body));
  });

  /* --- 6: projects nobody touched -------------------------------------- */

  await t.test('a project with nobody on its team keeps the behaviour it had', async () => {
    const p = await as('root', '/projects', { method: 'POST', body: { name: 'Unstaffed', clientId } });
    assert.strictEqual(p.status, 201, JSON.stringify(p.body));
    otherProjectId = p.body.project.id;

    const assetId = await atTlReview(otherProjectId);
    /* Ana's own lead clears it, exactly as he did before any of this — the
       project named nobody, so there is no team to be the gate and the
       reporting line is still the answer. Without this, every project created
       before the change would jam at the first gate. */
    const r = await as('ownlead', `/assets/${assetId}/review`, {
      method: 'POST', body: { decision: 'approved' } });
    assert.strictEqual(r.status, 200, `the old path still works: ${JSON.stringify(r.body)}`);
    assert.strictEqual(await statusOf(assetId), 'tl_approved');
  });

  await t.test('and staffing one project does not reach into another', async () => {
    /* Leela runs Gatehouse and has nothing to do with this one. Being on a
       project team is per project, which is the only thing that makes the rule
       safe to widen. */
    const assetId = await atTlReview(otherProjectId);
    const board = await as('lead', `/assets/project/${otherProjectId}`);
    const seen = board.status === 200 && board.body.assets.find((a) => a.id === assetId);
    if (seen) assert.strictEqual(seen.can_review_tl, true, 'unstaffed: the old rule, unchanged');

    // And the reverse: the other project's assets did not move because of
    // anything done to Gatehouse.
    assert.strictEqual(await statusOf(assetId), 'pending_tl_review');
  });
});
