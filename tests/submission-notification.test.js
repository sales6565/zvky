/* Telling people that work has been handed in.
 *
 * THE TWO TRIGGERS THE STUDIO ASKED FOR, and they point in opposite
 * directions:
 *
 *   assigned   travels DOWN. Somebody has given you work. Raised from
 *              assignments.open(), which every path that changes who holds an
 *              asset already funnels through, and covered by the first half of
 *              this file because the two must not be broken independently.
 *
 *   submitted  travels UP. Work you handed out has come back and is waiting on
 *              your review. New, and the reason this file exists.
 *
 * WHY THE SUBMISSION ONE IS NEW RATHER THAN OLD. There was an email for it and
 * deliberately no bell entry: the brief that added email said the screens were
 * not to change. An email nobody has open is not how somebody learns there is
 * a review waiting in the next ten minutes, so the studio asked for the
 * notification as well. The audience is the same either way, and that is now
 * enforced rather than hoped for: assignments.submissionAudience() answers it
 * once and both channels are handed the answer.
 *
 * FOUR THINGS THIS FILE EXISTS TO STOP:
 *
 *   A submission must not be announced as an assignment. They are different
 *      facts with different sentences, and the page used to title everything
 *      that was not an unassignment "Assigned to you" — so a lead would have
 *      been told they had been GIVEN an asset they were meant to REVIEW.
 *
 *   One event must not become two rows for one person. Whoever assigned the
 *      work is very often also the submitter's team lead. One recipient.
 *
 *   The submitter must not be told about their own submission, however many
 *      of the roles above they happen to hold.
 *
 *   It must fire on SUBMIT and on nothing else. Accepting and starting is the
 *      same person picking up work they already had; nobody is waiting on it.
 */
const test = require('node:test');
const assert = require('node:assert');

const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON } = require('./helpers');
const notifications = require('../src/notifications');
const assignments = require('../src/assignments');

const cfg = config('submitnotif');

// --- the wording, without a database ------------------------------------------

test('a submission reads as a submission, not as an assignment', () => {
  const row = {
    kind: 'submitted', asset_code: 'FX-001', asset_name: 'Big Win Burst',
    project_name: 'Reef Riches', other_name: 'Ana Artist',
  };
  const sentence = notifications.describe(row);
  assert.match(sentence, /Ana Artist submitted FX-001/, 'who did what');
  assert.match(sentence, /Big Win Burst/, 'and to which asset');
  assert.match(sentence, /Reef Riches/, 'and on which job — the reader hands work out across several');
  assert.match(sentence, /for review/, 'and what is now wanted of the reader');
  assert.ok(!/assigned you/.test(sentence),
    'a reviewer told "assigned you" would go and do the work themselves');
});

test('it still reads with nothing but the code', () => {
  /* Every other piece is a LEFT JOIN away and can be null: an account deleted,
     a project row missing on an old deployment. A sentence that renders as
     "undefined submitted" is worse than a vague one. */
  assert.strictEqual(
    notifications.describe({ kind: 'submitted', asset_code: 'FX-001' }),
    'Somebody submitted FX-001 for review.'
  );
});

test('the page has a title for every kind, and no binary fallback', () => {
  /* The desktop pop-up and the in-app toast carried a copy each of
     `kind === 'unassigned' ? … : 'Assigned to you'`. On a list of nine kinds
     that is not a default, it is a wrong answer for seven of them. */
  const fs = require('node:fs');
  const path = require('node:path');
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  const block = page.match(/const NOTIF_TITLES = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'public/index.html has no NOTIF_TITLES map');
  const titled = [...block[1].matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]);

  const missing = Object.values(notifications.KINDS).filter((k) => !titled.includes(k));
  assert.deepStrictEqual(missing, [],
    `these kinds would arrive under the wrong heading: ${missing.join(', ')}`);

  assert.ok(!/'Assigned to you'\s*\)/.test(page) || titled.includes('assigned'),
    'the old inline binary is gone');
});

// --- against a live server -----------------------------------------------------

test('submission notifications', { skip: cfg ? false : SKIP_REASON }, async (t) => {
  const PASSWORD = 'Submit-Notify-1!';
  let server;
  let projectId;
  const token = {};
  const id = {};

  const as = (who, p, options = {}) => api(server.base, p, { ...options, token: token[who] });
  const login = async (email) =>
    (await api(server.base, '/auth/login', { method: 'POST', body: { email, password: PASSWORD } })).body.token;

  /* Only what THIS action raised. The poll cursor is a sequence number, so
     taking one before an action and reading past it afterwards is what makes
     "exactly one notification" a checkable claim rather than a count of
     everything that has ever happened to this person. */
  const mark = async (who) => (await as(who, '/notifications/poll')).body.cursor;
  const since = async (who, cursor) => (await as(who, `/notifications/poll?since=${cursor}`)).body.fresh || [];

  t.before(async () => {
    await resetSchema(cfg);
    server = await startServer(cfg, { BOOTSTRAP_TOKEN: 'test-bootstrap-token' });
    await api(server.base, '/auth/bootstrap', {
      method: 'POST',
      body: { token: 'test-bootstrap-token', name: 'Root Admin', email: 'root@zvky.test', password: PASSWORD },
    });
    token.root = await login('root@zvky.test');
    id.root = (await as('root', '/auth/me')).body.user.id;

    const make = async (key, name, email, role, teamLeadId) => {
      const r = await as('root', '/users', {
        method: 'POST', body: { name, email, role, password: PASSWORD, teamLeadId },
      });
      assert.strictEqual(r.status, 201, `${role}: ${JSON.stringify(r.body)}`);
      id[key] = r.body.user.id;
      token[key] = await login(email);
    };
    await make('lead', 'Lena Lead', 'lead@zvky.test', 'team_lead');
    await make('ana', 'Ana Artist', 'ana@zvky.test', 'game_artist', id.lead);
    await make('solo', 'Solo Artist', 'solo@zvky.test', 'game_artist');   // reports to nobody
    await make('cd', 'Cy Director', 'cd@zvky.test', 'creative_art_director');

    const clients = await as('root', '/clients');
    const project = await as('root', '/projects', {
      method: 'POST',
      body: { name: 'Reef Riches', clientId: clients.body.clients[0].id, teamLeadIds: [id.lead] },
    });
    assert.strictEqual(project.status, 201, JSON.stringify(project.body));
    projectId = project.body.project.id;
  });

  t.after(() => stopServer(server));

  let n = 0;
  const newAsset = async () => {
    const r = await as('root', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: `Asset ${n += 1}`, type: 'prop' },
    });
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));
    return r.body.asset;
  };
  const assign = async (asset, who, by = 'root') => {
    const r = await as(by, `/assets/${asset.id}`, { method: 'PATCH', body: { assigneeId: id[who] } });
    assert.strictEqual(r.status, 200, `assign: ${JSON.stringify(r.body)}`);
  };
  const start = async (asset, who) => {
    const r = await as(who, `/assets/${asset.id}/start`, { method: 'POST' });
    assert.strictEqual(r.status, 200, `start: ${JSON.stringify(r.body)}`);
  };
  const submit = async (asset, who, link = 'https://example.com/v1') =>
    as(who, `/assets/${asset.id}/submit`, { method: 'POST', body: { link, description: 'a round' } });

  const kinds = (list) => list.map((x) => x.kind);

  /* ----- 1 and 2: assignment, for a contributor and for a lead -------------- */

  await t.test('assigning tells the assignee, and only them', async () => {
    const asset = await newAsset();
    const cAna = await mark('ana');
    const cLead = await mark('lead');
    const cRoot = await mark('root');

    await assign(asset, 'ana');

    const ana = await since('ana', cAna);
    assert.deepStrictEqual(kinds(ana), ['assigned'], 'exactly one, and it is an assignment');
    assert.match(ana[0].message, /Root Admin assigned you/);
    assert.strictEqual(ana[0].assetId, asset.id, 'and it links to the asset');
    assert.deepStrictEqual(kinds(await since('lead', cLead)), [],
      'a lead is not copied in on every assignment to their team');
    assert.deepStrictEqual(kinds(await since('root', cRoot)), [],
      'and the person who did it is not told they did it');
  });

  await t.test('a Team Lead can be assigned work and is told, like anybody else', async () => {
    /* Leads only became assignable recently. Nothing in the notification path
       reads a role, so this should hold for free — which is exactly the kind
       of claim that is worth a test rather than an argument. */
    const asset = await newAsset();
    const c = await mark('lead');
    await assign(asset, 'lead');
    const got = await since('lead', c);
    assert.deepStrictEqual(kinds(got), ['assigned']);
    assert.match(got[0].message, /assigned you/);
  });

  /* ----- 3: bulk --------------------------------------------------------- */

  await t.test('a bulk assign raises one notification per asset, per person', async () => {
    const a = await newAsset();
    const b = await newAsset();
    const c = await newAsset();
    const cAna = await mark('ana');
    const cLead = await mark('lead');

    const one = await as('root', '/assets/bulk/assign', {
      method: 'POST', body: { assetIds: [a.id, b.id], assigneeId: id.ana },
    });
    const two = await as('root', '/assets/bulk/assign', {
      method: 'POST', body: { assetIds: [c.id], assigneeId: id.lead },
    });
    assert.strictEqual(one.body.applied, 2, JSON.stringify(one.body));
    assert.strictEqual(two.body.applied, 1, JSON.stringify(two.body));

    const ana = await since('ana', cAna);
    assert.strictEqual(ana.length, 2, 'two assets, two notifications — not one for the batch');
    assert.deepStrictEqual([...new Set(ana.map((x) => x.assetId))].sort(), [a.id, b.id].sort(),
      'and each names its own asset rather than one garbled sentence about both');
    assert.strictEqual((await since('lead', cLead)).length, 1, 'the other person got only theirs');
  });

  /* ----- 4: unassigning is not an assignment ------------------------------ */

  await t.test('unassigning fires no assignment notification', async () => {
    const asset = await newAsset();
    await assign(asset, 'ana');
    const c = await mark('ana');

    const r = await as('root', `/assets/${asset.id}`, { method: 'PATCH', body: { assigneeId: null } });
    assert.strictEqual(r.status, 200, JSON.stringify(r.body));

    const got = await since('ana', c);
    assert.ok(!kinds(got).includes('assigned'),
      'there is no new assignee, so there is nobody to tell they have been given work');
    assert.deepStrictEqual(kinds(got), ['unassigned'], 'only that it left them');
  });

  /* ----- 5: the submission ----------------------------------------------- */

  await t.test('THE NEW TRIGGER: submitting tells the assigner and the team lead', async () => {
    const asset = await newAsset();
    await assign(asset, 'ana');
    await start(asset, 'ana');

    const cRoot = await mark('root');   // assigned it
    const cLead = await mark('lead');   // Ana's team lead
    const cCd = await mark('cd');       // uninvolved
    const cAna = await mark('ana');     // submitted it

    const r = await submit(asset, 'ana');
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));

    const root = await since('root', cRoot);
    const lead = await since('lead', cLead);
    assert.deepStrictEqual(kinds(root), ['submitted'], 'the person who handed the work out');
    assert.deepStrictEqual(kinds(lead), ['submitted'], 'and the lead who has to review it');
    assert.match(root[0].message, /Ana Artist submitted/, 'naming who did it');
    assert.match(root[0].message, /Reef Riches/, 'and which job it is on');
    assert.strictEqual(root[0].assetId, asset.id, 'and linking to the asset so one click opens it');

    assert.deepStrictEqual(kinds(await since('ana', cAna)), [],
      'the submitter already knows — they just pressed the button');
    assert.deepStrictEqual(kinds(await since('cd', cCd)), [],
      'and it is not broadcast to everybody who could see the asset');
  });

  await t.test('it fires on submit and not on starting', async () => {
    const asset = await newAsset();
    await assign(asset, 'ana');

    const cRoot = await mark('root');
    const cLead = await mark('lead');
    await start(asset, 'ana');
    assert.deepStrictEqual(kinds(await since('root', cRoot)), [],
      'picking work up is not news to anybody');
    assert.deepStrictEqual(kinds(await since('lead', cLead)), []);

    const cAfter = await mark('root');
    await submit(asset, 'ana');
    assert.deepStrictEqual(kinds(await since('root', cAfter)), ['submitted'], 'handing it in is');
  });

  await t.test('one person wearing both hats is told once, not twice', async () => {
    /* The assigner is very often also the submitter's team lead — it is the
       ordinary shape of a studio. Two rows for one event would put the same
       sentence in the bell twice and buzz the desktop twice. */
    /* Created BY the lead, because asset.assign reaches the assets you own:
       the lead assigning work they raised themselves is the ordinary shape of
       this, and it is what puts their id on assigned_by_id. */
    const made = await as('lead', `/assets/project/${projectId}`, {
      method: 'POST', body: { name: `Lead's Own ${n += 1}`, type: 'prop' },
    });
    assert.strictEqual(made.status, 201, JSON.stringify(made.body));
    const asset = made.body.asset;
    await assign(asset, 'ana', 'lead');       // the lead assigns to their own report
    await start(asset, 'ana');

    const c = await mark('lead');
    const r = await submit(asset, 'ana');
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));

    const got = await since('lead', c);
    assert.strictEqual(got.length, 1,
      `the lead is both the assigner and the team lead and got ${got.length} notifications`);
  });

  await t.test('the audience itself, asked directly', async () => {
    /* Through the API, TWO guards stand between a submitter and their own
       notification: submissionAudience() drops them from the list, and raise()
       refuses a recipient who is also the actor. That is deliberate belt and
       braces — but it means removing either one on its own changes nothing
       observable from outside, so neither is really under test. This asks the
       function directly, which is the only way to hold up its half.
       
       A thin adapter, because the module speaks the app's db interface and
       the test helper speaks mysql2. It repeats a parameter in the order the
       placeholders appear rather than replacing $n blindly — which is what
       src/db.js does, and what this query needs: it mentions $2 before $1, so
       a naive swap binds the actor's id as the asset's and quietly finds
       nothing. */
    const db = {
      query: async (text, params = []) => {
        const ordered = [];
        const statement = text.replace(/\$(\d+)/g, (_, n) => {
          ordered.push(params[Number(n) - 1]);
          return '?';
        });
        return { rows: await sql(cfg, statement, ordered) };
      },
    };

    const asset = await newAsset();
    await assign(asset, 'ana');

    const audience = await assignments.submissionAudience(db, { assetId: asset.id, actorId: id.ana });
    assert.deepStrictEqual([...audience].sort(), [id.root, id.lead].sort(),
      'the assigner and the submitter\'s team lead, and nobody else');

    /* The submitter is dropped even when they are one of the two. Ana's own
       lead submitting work Ana assigned would otherwise be told by their own
       hand. */
    const selfAudience = await assignments.submissionAudience(db, { assetId: asset.id, actorId: id.root });
    assert.ok(!selfAudience.includes(id.root),
      'the actor is never in their own audience — and this is the guard that says so');
  });

  await t.test('a lead submitting their own work tells nobody it was them', async () => {
    const asset = await newAsset();
    await assign(asset, 'lead');
    await start(asset, 'lead');

    const cLead = await mark('lead');
    const cRoot = await mark('root');
    const r = await submit(asset, 'lead');
    assert.strictEqual(r.status, 201, JSON.stringify(r.body));

    assert.deepStrictEqual(kinds(await since('lead', cLead)), [],
      'they are their own assigner-adjacent reviewer; they do not need telling');
    assert.deepStrictEqual(kinds(await since('root', cRoot)), ['submitted'],
      'the person who assigned it still hears');
  });

  await t.test('somebody with no team lead still reaches their assigner', async () => {
    const asset = await newAsset();
    await assign(asset, 'solo');
    await start(asset, 'solo');
    const c = await mark('root');
    await submit(asset, 'solo');
    assert.deepStrictEqual(kinds(await since('root', c)), ['submitted'],
      'the team lead half is optional; the assigner half is not');
  });

  /* ----- 6: no duplicates on a retry -------------------------------------- */

  await t.test('a repeated submit does not repeat the notification', async () => {
    const asset = await newAsset();
    await assign(asset, 'ana');
    await start(asset, 'ana');

    const c = await mark('root');
    const first = await submit(asset, 'ana');
    const second = await submit(asset, 'ana');
    assert.strictEqual(first.status, 201);
    assert.ok(second.status >= 400,
      `the workflow must refuse a second submit from a review queue (got ${second.status})`);

    assert.strictEqual((await since('root', c)).length, 1,
      'a double-click produced two notifications');
  });

  await t.test('but a re-submission after changes is a new event and notifies again', async () => {
    const asset = await newAsset();
    await assign(asset, 'ana');
    await start(asset, 'ana');
    await submit(asset, 'ana');

    const sentBack = await as('lead', `/assets/${asset.id}/review`, {
      method: 'POST', body: { decision: 'changes_requested', text: 'tighten the silhouette' },
    });
    assert.ok(sentBack.status < 400, `review: ${JSON.stringify(sentBack.body)}`);

    await start(asset, 'ana');
    const c = await mark('root');
    const round2 = await submit(asset, 'ana', 'https://example.com/v2');
    assert.strictEqual(round2.status, 201, JSON.stringify(round2.body));
    assert.deepStrictEqual(kinds(await since('root', c)), ['submitted'],
      'round two is a second round of work, waiting on them again');
  });

  await t.test('reassigning several times in a row raises one per move, not a pile', async () => {
    const asset = await newAsset();
    const cAna = await mark('ana');
    const cSolo = await mark('solo');

    await assign(asset, 'ana');
    await assign(asset, 'solo');
    await assign(asset, 'ana');

    const ana = await since('ana', cAna);
    const solo = await since('solo', cSolo);
    assert.deepStrictEqual(kinds(ana), ['assigned', 'unassigned', 'assigned'],
      'given it, lost it, given it again — three moves, three notices, in order');
    assert.deepStrictEqual(kinds(solo), ['assigned', 'unassigned']);
  });

  /* ----- 7: nothing else changed ----------------------------------------- */

  await t.test('the other notification kinds are untouched', async () => {
    /* The password reset raises its own kind through its own function. It is
       here because it is the easiest of the unrelated kinds to raise from a
       test, and because "we added one kind and broke another" is the shape of
       regression this section is for. */
    const reset = await as('root', `/users/${id.solo}/reset-password`, { method: 'POST' });
    assert.strictEqual(reset.status, 200, `reset: ${JSON.stringify(reset.body)}`);

    /* A reset signs the account's other devices out, so their existing token
       is dead and the poll cursor with it — which is why this reads the list
       through a fresh session rather than through since(). Worth the extra
       step: it is the one kind raised from outside the asset routes, so it is
       the one most likely to be broken by a change to them and not noticed. */
    token.solo = (await api(server.base, '/auth/login', {
      method: 'POST', body: { email: 'solo@zvky.test', password: reset.body.temporaryPassword },
    })).body.token;
    assert.ok(token.solo, 'the temporary password should sign them back in');
    /* And out of the must-change-password hold, which otherwise refuses every
       other route including the bell. */
    const changed = await as('solo', '/auth/password', {
      method: 'POST',
      body: { currentPassword: reset.body.temporaryPassword, newPassword: 'Solo-Chosen-1!' },
    });
    assert.strictEqual(changed.status, 200, `change: ${JSON.stringify(changed.body)}`);
    token.solo = changed.body.token || token.solo;

    const list = await as('solo', '/notifications?limit=5');
    assert.strictEqual(list.status, 200, JSON.stringify(list.body));
    const newest = list.body.notifications[0];
    assert.strictEqual(newest.kind, 'password_reset');
    assert.match(newest.message, /reset your password/);
    assert.ok(!/submitted/.test(newest.message), 'and it did not pick up the new sentence');
  });

  await t.test('a chat message still notifies through chat, not through the bell', async () => {
    /* The two channels are separate on purpose: chat has its own unread count
       and its own pop-up. A submission notification landing in the bell must
       not have moved chat into it, or quietened it. */
    const c = await mark('ana');
    const convo = await as('root', '/chat/direct', { method: 'POST', body: { userId: id.ana } });
    assert.strictEqual(convo.status, 200, `open: ${JSON.stringify(convo.body)}`);
    const sent = await as('root', `/chat/${convo.body.conversationId}/messages`, {
      method: 'POST', body: { body: 'are you free this afternoon?' },
    });
    assert.ok(sent.status < 400, `chat: ${sent.status} ${JSON.stringify(sent.body)}`);

    assert.deepStrictEqual(kinds(await since('ana', c)), [],
      'a chat message is not a work notification and does not appear in the bell');
    const poll = await as('ana', '/chat/poll');
    assert.strictEqual(poll.status, 200, JSON.stringify(poll.body));
    assert.ok(JSON.stringify(poll.body).includes('are you free') || Number(poll.body.unread) > 0,
      `chat still reports it on its own channel: ${JSON.stringify(poll.body).slice(0, 200)}`);
  });

  await t.test('the bell and the page agree about what each kind is called', async () => {
    /* Every row the API can return has to render. A kind the page has no title
       for would arrive under a fallback, which is the bug this replaced. */
    const list = await as('root', '/notifications?limit=50');
    assert.strictEqual(list.status, 200);
    const seen = [...new Set(list.body.notifications.map((x) => x.kind))];
    assert.ok(seen.includes('submitted'), `the new kind should be in here: ${seen.join(', ')}`);
    for (const row of list.body.notifications) {
      assert.ok(row.message && !/undefined|null/.test(row.message),
        `a notification rendered badly: ${row.kind} -> ${row.message}`);
    }
  });
});
