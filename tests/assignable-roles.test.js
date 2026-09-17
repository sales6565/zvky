/* Who can be handed work.
 *
 * Leads used to be missing from every Assignee dropdown, and the cause was one
 * flag: `assignable` was set on the contributor tier and nowhere else, so
 * assignableRoles() — which is what GET /projects/:id/artists filters on, and
 * that one endpoint is what fills the create form, the reassign panel AND the
 * bulk panel — had no lead in it.
 *
 * FOUR THINGS THIS FILE EXISTS TO STOP, because setting that flag is a one-line
 * change with three traps in it:
 *
 *   A lead must not lose their team's work. Two places read `assignable` as
 *      "sees only their own assignments" and returned out of that branch before
 *      ever testing leadsTeam — canViewAsset, and the per-project list query.
 *      The moment leads became assignable, both would have narrowed a lead to
 *      their own desk and taken away the board and the review queue. The list
 *      query's own comment says the two must agree; these tests are what makes
 *      "must" checkable.
 *
 *   A lead must actually appear in the NARROW list. That list is keyed on
 *      team_lead_id, and a lead's own team_lead_id is almost always NULL, so
 *      the role filter alone would have let them through and matched no row —
 *      the bug would have looked fixed only to someone holding asset.assign_any.
 *
 *   Nothing else may become assignable. Production, Direction, Admin, Super
 *      Admin and Staff were excluded on purpose and stay excluded.
 *
 *   The three assign routes must agree. PATCH, bulk and reassign all decide
 *      who may RECEIVE work, and two of them never asked — a gap that predates
 *      this change and is closed with it.
 */
const test = require('node:test');
const assert = require('node:assert');

const { config, resetSchema, startServer, stopServer, api, SKIP_REASON } = require('./helpers');
const { capabilitiesForTier } = require('../src/role-tiers');
const defaults = require('../src/reference-defaults');

const cfg = config('assignableroles');

// The catalogue as roles.js builds it, without needing a database.
const ROLES = defaults.ROLES.map((r) => ({ ...r, ...capabilitiesForTier(r.tier) }));
const byKey = (k) => ROLES.find((r) => r.key === k);

// --- the flag itself ---------------------------------------------------------

test('a lead is assigned work as well as handing it out', () => {
  const lead = byKey('team_lead');
  assert.strictEqual(lead.assignable, true, 'the whole of the reported bug');
  assert.strictEqual(lead.leadsTeam, true, 'and it still leads a team');
});

test('every designation in the Lead / Supervisor tier is assignable, not just the one named', () => {
  /* Capabilities come from the TIER — src/reference-data.js builds each role's
     flags with capabilitiesForTier() and the roles table stores no capability
     of its own. So this is a property of the tier, and picking out one role
     would have meant a hardcoded role-name check. */
  const leads = ROLES.filter((r) => r.tier === 'lead');
  assert.strictEqual(leads.length, 7, 'if this changes, the list below is stale');
  for (const r of leads) {
    assert.strictEqual(r.assignable, true, `${r.key} is in the lead tier and must be assignable`);
  }
});

test('contributors are unchanged', () => {
  for (const r of ROLES.filter((x) => x.tier === 'contributor')) {
    assert.strictEqual(r.assignable, true, `${r.key} was assignable before and must stay so`);
  }
});

test('the designations that were excluded on purpose are still excluded', () => {
  /* The regression that matters in the other direction. Naming the tiers rather
     than counting roles, so adding a Producer designation later cannot quietly
     make this pass for the wrong reason. */
  for (const tier of ['super_admin', 'admin', 'production', 'direction', 'full_access', 'leadership', 'staff']) {
    const inTier = ROLES.filter((r) => r.tier === tier);
    assert.ok(inTier.length, `no role in tier ${tier} — the fixture is wrong`);
    for (const r of inTier) {
      assert.strictEqual(r.assignable, undefined === r.assignable ? undefined : false,
        `${r.key} (${tier}) must not be assignable`);
      assert.ok(!r.assignable, `${r.key} (${tier}) must not be assignable`);
    }
  }
});

test('exactly two tiers are assignable', () => {
  const tiers = [...new Set(ROLES.filter((r) => r.assignable).map((r) => r.tier))].sort();
  assert.deepStrictEqual(tiers, ['contributor', 'lead']);
});

// --- against a live server ---------------------------------------------------

test('assigning work to a lead', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Assignable-Test-1!';
  let server;
  let admin;      // super admin, holds asset.assign_any
  let leadTok;
  let ids = {};
  let projectId;

  const call = (p, options) => api(server.base, p, options);
  const login = async (email) =>
    (await call('/auth/login', { method: 'POST', body: { email, password: PASSWORD } })).body.token;

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'test-bootstrap-token' });
    await call('/auth/bootstrap', {
      method: 'POST',
      body: { token: 'test-bootstrap-token', name: 'Root', email: 'root@zvky.test', password: PASSWORD },
    });
    admin = await login('root@zvky.test');

    const make = async (name, email, role) => {
      const r = await call('/users', { token: admin, method: 'POST', body: { name, email, role, password: PASSWORD } });
      assert.strictEqual(r.status, 201, `${role}: ${JSON.stringify(r.body)}`);
      return r.body.user.id;
    };
    ids.lead = await make('Lena Lead', 'lead@zvky.test', 'team_lead');
    ids.artist = await make('Ana Artist', 'artist@zvky.test', 'game_artist');
    ids.producer = await make('Percy Producer', 'producer@zvky.test', 'producer');
    leadTok = await login('lead@zvky.test');

    const clients = await call('/clients', { token: admin });
    const clientId = clients.body.clients[0].id;
    /* teamLeadIds attaches the lead to the project. Without it the lead has no
       access to it at all — projectScope 'team' — and every check below would
       fail 403 for a reason that has nothing to do with assignability. */
    const project = await call('/projects', {
      token: admin, method: 'POST',
      body: { name: 'Assignability', clientId, teamLeadIds: [ids.lead] },
    });
    assert.strictEqual(project.status, 201, JSON.stringify(project.body));
    projectId = project.body.project.id;
  });

  t.after(() => stopServer(server));

  const newAsset = async (name) => {
    const r = await call(`/assets/project/${projectId}`, {
      token: admin, method: 'POST', body: { name, type: 'prop' },
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    return r.body.asset;
  };

  await t.test('the Assignee list offers leads, and still refuses what it always refused', async () => {
    const r = await call(`/projects/${projectId}/artists`, { token: admin });
    assert.strictEqual(r.status, 200);
    const roles = r.body.artists.map((a) => a.role);
    assert.ok(roles.includes('team_lead'), 'the fix');
    assert.ok(roles.includes('game_artist'), 'and the designations that already worked');
    assert.ok(!roles.includes('producer'), 'production is not assigned work');
    assert.ok(!roles.includes('super_admin'), 'nor is the super admin');
  });

  await t.test('a lead appears in the narrow list too, not only to a holder of asset.assign_any', async () => {
    /* The narrow path is the one a lead staffing their own project gets, and it
       matches on team_lead_id — which a lead does not have. Without the leads
       being named explicitly this returns everyone EXCEPT the people the fix
       was about. */
    const r = await call(`/projects/${projectId}/artists`, { token: leadTok });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const roles = r.body.artists.map((a) => a.role);
    assert.ok(roles.includes('team_lead'), `scope ${r.body.scope} still had no lead in it`);
  });

  await t.test('a lead can be assigned work, and is told about it', async () => {
    const asset = await newAsset('Lead Takes This');
    const before = (await call('/notifications', { token: leadTok })).body.notifications.length;
    const r = await call(`/assets/${asset.id}`, {
      token: admin, method: 'PATCH', body: { assigneeId: ids.lead },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
    const after = (await call('/notifications', { token: leadTok })).body.notifications;
    assert.ok(after.length > before, 'the usual assignment notification is raised');
    assert.match(JSON.stringify(after[0]), /Lead Takes This/);
  });

  await t.test('and in bulk', async () => {
    const a = await newAsset('Bulk One');
    const b = await newAsset('Bulk Two');
    const r = await call('/assets/bulk/assign', {
      token: admin, method: 'POST', body: { assetIds: [a.id, b.id], assigneeId: ids.lead },
    });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  });

  await t.test('a lead can act on work assigned to them', async () => {
    const asset = await newAsset('Lead Does This');
    await call(`/assets/${asset.id}`, { token: admin, method: 'PATCH', body: { assigneeId: ids.lead } });
    const started = await call(`/assets/${asset.id}/start`, { token: leadTok, method: 'POST' });
    assert.strictEqual(started.status, 200, JSON.stringify(started.body));
    const submitted = await call(`/assets/${asset.id}/submit`, {
      token: leadTok, method: 'POST', body: { note: 'done', link: 'https://example.com/v1' },
    });
    assert.strictEqual(submitted.status, 201, JSON.stringify(submitted.body));
  });

  await t.test('THE REGRESSION: a lead still sees the work that is not theirs', async () => {
    /* canViewAsset and the list query both branch on `assignable`, and both
       used to return from that branch before testing leadsTeam. If either
       reverts, a lead's board collapses to their own desk — which is how this
       feature would break a lead's whole job while looking like it worked. */
    const someoneElses = await newAsset('Not The Leads Work');
    await call(`/assets/${someoneElses.id}`, {
      token: admin, method: 'PATCH', body: { assigneeId: ids.artist },
    });

    const board = await call(`/assets/project/${projectId}`, { token: leadTok });
    assert.strictEqual(board.status, 200);
    const visible = board.body.assets.map((a) => a.id);
    assert.ok(visible.includes(someoneElses.id),
      'the lead lost sight of an asset assigned to somebody else — the board narrowed');
    /* Checked through the per-project list and not a single-asset read: there
       is no GET /api/assets/:id, so that path falls through to the SPA
       catch-all and answers index.html with a 200 — which would make this
       assertion pass whatever the permissions said. */
  });

  await t.test('a contributor is still narrowed to their own work', async () => {
    // The other half of the same rule: widening the lead must not widen them.
    const artistTok = await login('artist@zvky.test');
    const hidden = await newAsset('Artist Cannot See This');
    await call(`/assets/${hidden.id}`, { token: admin, method: 'PATCH', body: { assigneeId: ids.lead } });

    const board = await call(`/assets/project/${projectId}`, { token: artistTok });
    const visible = (board.body.assets || []).map((a) => a.id);
    assert.ok(!visible.includes(hidden.id), 'a contributor sees only their own work');
    assert.ok(visible.length < board.body.assets.length + 1, 'and the list is genuinely narrowed');
  });

  await t.test('a lead cannot review their own submission', async () => {
    /* The hazard that comes WITH making leads assignable, and the reason the
       catalogue used to forbid a designation being both assignable and a lead.
       
       A lead has no team_lead_id of their own, so an asset assigned to them
       reaches isTeamLeadOfAsset's "no lead recorded — any lead who can see
       this is the gate" fallback, and the lead who submitted it can see it.
       Without the guard in permissions.js they would approve their own work
       through the first review gate. */
    const asset = await newAsset('Lead Reviews Themselves');
    await call(`/assets/${asset.id}`, { token: admin, method: 'PATCH', body: { assigneeId: ids.lead } });
    await call(`/assets/${asset.id}/start`, { token: leadTok, method: 'POST' });
    const submitted = await call(`/assets/${asset.id}/submit`, {
      token: leadTok, method: 'POST', body: { note: 'mine', link: 'https://example.com/self' },
    });
    assert.strictEqual(submitted.status, 201, JSON.stringify(submitted.body));

    const selfReview = await call(`/assets/${asset.id}/review`, {
      token: leadTok, method: 'POST', body: { decision: 'approved' },
    });
    assert.ok(selfReview.status >= 400,
      `a lead approved their own submission (${selfReview.status}) — the self-review guard is gone`);
  });

  await t.test('no route will hand work to a designation that is not assigned work', async () => {
    /* All three ask the same question and give the same sentence. Two of them
       did not ask at all before this change: the dropdown hid a Producer and a
       direct request put the work on them anyway. */
    const asset = await newAsset('Nobody Ineligible');
    for (const who of [ids.producer, ids.root].filter(Boolean)) {
      const single = await call(`/assets/${asset.id}`, {
        token: admin, method: 'PATCH', body: { assigneeId: who },
      });
      assert.strictEqual(single.status, 400, 'PATCH must refuse');
      assert.match(single.body.error, /not assigned work/);

      const bulk = await call('/assets/bulk/assign', {
        token: admin, method: 'POST', body: { assetIds: [asset.id], assigneeId: who },
      });
      assert.strictEqual(bulk.status, 400, 'bulk must refuse the same way');
      assert.match(bulk.body.error, /not assigned work/);
    }

    // And the two things that must still be allowed.
    const toLead = await call(`/assets/${asset.id}`, {
      token: admin, method: 'PATCH', body: { assigneeId: ids.lead },
    });
    assert.strictEqual(toLead.status, 200, 'a lead is eligible');
    const cleared = await call(`/assets/${asset.id}`, {
      token: admin, method: 'PATCH', body: { assigneeId: null },
    });
    assert.strictEqual(cleared.status, 200, 'unassigning is not giving it to anybody');
  });
});
