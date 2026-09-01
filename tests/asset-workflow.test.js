const test = require('node:test');
const assert = require('node:assert');
const { config, resetSchema, startServer, stopServer, api, sql, SKIP_REASON, systemClientId } = require('./helpers');
const workflow = require('../src/asset-workflow');
const submissionLink = require('../src/submission-link');

const cfg = config('workflow');

// --- the machine, on its own --------------------------------------------------

test('the ten states match the dashboard, in pipeline order', () => {
  assert.deepStrictEqual(workflow.STATES.map((s) => s.id), [
    'not_started', 'assigned', 'in_progress', 'pending_tl_review', 'tl_changes_requested',
    'pending_cd_review', 'cd_changes_requested', 'approved_for_client',
    'awaiting_client_feedback', 'delivered',
  ]);
  assert.deepStrictEqual(workflow.STATES.map((s) => s.label), [
    'Not Assigned', 'Assigned', 'In Progress', 'TL Review', 'TL Feedbacks',
    'CD Review', 'CD Feedbacks', 'Approved for Client',
    'Awaiting Client Feedback', 'Delivered',
  ]);

  // The client's step sits between the studio's sign-off and delivery, which is
  // the whole point of it — and its colour is its own, not the brand's.
  const ids = workflow.STATES.map((s) => s.id);
  assert.strictEqual(ids.indexOf('awaiting_client_feedback'), ids.indexOf('approved_for_client') + 1);
  assert.strictEqual(ids.indexOf('delivered'), ids.indexOf('awaiting_client_feedback') + 1);
  const client = workflow.STATES.find((s) => s.id === 'awaiting_client_feedback');
  assert.ok(!/7f1416/i.test(client.color) && !/--brand\b/.test(client.color),
    'a status colour must not be the brand colour');
});

/* Nothing may branch on what a status is CALLED.
 *
 * Three labels have now been renamed without touching a key — 'not_started' is
 * shown as "Not Assigned", 'tl_changes_requested' as "TL Feedbacks" and
 * 'cd_changes_requested' as "CD Feedbacks" — and the first of those broke a
 * hardcoded comparison against the old wording. That
 * is the worst shape of bug this codebase can produce: it does not throw, the
 * page still draws, and a stage test quietly starts answering false somewhere
 * nobody is looking. The routing back to an assignee out of a review is exactly
 * such a test.
 *
 * So the rule is checked rather than remembered: every stage comparison must be
 * against the id. A label may be reworded at any time by editing the two lists
 * and nothing else. */
test('no code compares against a status label', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const root = path.join(__dirname, '..');

  const files = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(js|html)$/.test(entry.name)) files.push(full);
    }
  };
  walk(path.join(root, 'src'));
  files.push(path.join(root, 'public', 'index.html'));

  /* The definition sites, where a label legitimately appears as a string
     literal. Everywhere else it may only be read off a state object. */
  const DEFINITIONS = ['src/asset-workflow.js', 'public/index.html'];

  const offenders = [];
  for (const file of files) {
    const rel = path.relative(root, file);
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      // Skip the lines that define the labels in the first place.
      if (DEFINITIONS.includes(rel) && /label:\s*'/.test(line)) return;
      for (const state of workflow.STATES) {
        /* A comparison, a membership test, or a switch case against the
           displayed words. Anything that would change behaviour if somebody
           reworded the label. */
        const quoted = state.label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const patterns = [
          new RegExp(`[=!]==?\\s*['"\`]${quoted}['"\`]`),
          new RegExp(`['"\`]${quoted}['"\`]\\s*[=!]==?`),
          new RegExp(`\\.(includes|indexOf|startsWith|endsWith)\\(\\s*['"\`]${quoted}['"\`]`),
          new RegExp(`case\\s+['"\`]${quoted}['"\`]`),
        ];
        if (patterns.some((re) => re.test(line))) {
          offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
        }
      }
    });
  }

  assert.deepStrictEqual(offenders, [],
    'these compare against a status LABEL, which is only the display wording — '
    + `compare against the id instead:\n${offenders.join('\n')}`);
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
  /* The stages not shown to everyone, and what makes each one worth showing.
     Every id must be a real state — a typo here would hide nothing and say
     nothing — and every permission must be a real key, or the rule can never
     be satisfied and the column would be invisible to the whole studio. */
  const restricted = page.match(/const RESTRICTED_STATUSES = \[([\s\S]*?)\n\];/);
  assert.ok(restricted, 'the restricted stages should be one named list');
  const rules = [...restricted[1].matchAll(/id:\s*'([^']+)'[^}]*needs:\s*\[([^\]]*)\]/g)]
    .map((m) => ({ id: m[1], needs: m[2].split(',').map((v) => v.trim().replace(/'/g, '')).filter(Boolean) }));

  assert.deepStrictEqual(rules.map((r) => r.id),
    ['not_started', 'pending_cd_review', 'cd_changes_requested', 'awaiting_client_feedback']);

  const catalogKeys = new Set(require('../src/permission-catalog').KEYS);
  for (const rule of rules) {
    assert.ok(workflow.STATE_IDS.includes(rule.id), `"${rule.id}" is not a status the pipeline has`);
    assert.ok(rule.needs.length, `"${rule.id}" has no permission that reveals it`);
    for (const key of rule.needs) {
      assert.ok(catalogKeys.has(key), `"${rule.id}" is gated on "${key}", which is not a permission`);
    }
  }

  /* The fix this encodes: a CD reviewer holding review.cd and not asset.add
     could not see the two stages their permission is entirely about. */
  for (const id of ['pending_cd_review', 'cd_changes_requested']) {
    const rule = rules.find((r) => r.id === id);
    assert.ok(rule.needs.includes('review.cd'), `${id} must be visible to a CD reviewer`);
    assert.ok(rule.needs.includes('asset.add'), `${id} must stay visible to whoever sets work up`);
  }
  // Not Assigned deliberately stays with asset.add alone: acting on that queue
  // means putting somebody on it, which reviewing does not.
  assert.deepStrictEqual(rules.find((r) => r.id === 'not_started').needs, ['asset.add']);

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

test('reviewing and handing on are independent sections of the asset panel', () => {
  // Reviewing a submission and handing it to somebody else are two separate
  // choices at the same stage, gated by two separate permissions. Adding the
  // handover must never nest inside, or push out, the review controls — and to
  // whoever holds only one of the two it looks exactly as if it had. This pins
  // the shape so the same thing cannot be done to the CD block later.
  const fs = require('node:fs');
  const path = require('node:path');
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  const at = (needle) => {
    const i = page.indexOf(needle);
    assert.notStrictEqual(i, -1, `the panel should contain ${needle}`);
    return i;
  };

  // Each section opens its own conditional, at the top level of the template.
  for (const gate of ['${canTlReview ? `', '${canCdReview ? `', '${canHandOver ? `']) {
    assert.ok(page.includes(gate), `${gate} should be its own top-level branch`);
  }

  // Review comes first: it is the decision the asset is waiting for.
  assert.ok(at('${canTlReview ? `') < at('${canHandOver ? `'),
    'the team lead review block must render before the handover block');
  assert.ok(at('${canCdReview ? `') < at('${canHandOver ? `'),
    'and so must the creative director block');

  // Neither review block may live inside the handover branch, which is the
  // shape that would make one replace the other.
  const handover = page.slice(at('${canHandOver ? `'));
  const handoverBlock = handover.slice(0, handover.indexOf('` : \'\'}'));
  for (const control of ['tlApproveBtn', 'tlReqChangesBtn', 'cdApproveBtn', 'cdReqChangesBtn']) {
    assert.ok(!handoverBlock.includes(control),
      `${control} must not be nested inside the handover section`);
  }

  // The two review stages own their own ids. One shared pair across two blocks
  // is a collision waiting for the day they can both render.
  for (const id of ['tlReviewNote', 'tlReqChangesBtn', 'tlApproveBtn',
    'cdReviewNote', 'cdReqChangesBtn', 'cdApproveBtn']) {
    const uses = page.split(`id="${id}"`).length - 1;
    assert.strictEqual(uses, 1, `${id} should be declared exactly once — found ${uses}`);
  }
});

test('every status belongs to exactly one Assets List tab', () => {
  // The tabs divide the whole enum. A status placed in none of them would stop
  // appearing in the list altogether — work that exists and cannot be found is
  // the worst failure this screen has — and one placed in two would be counted
  // twice. Neither is visible by looking at the page, so it is asserted here.
  const fs = require('node:fs');
  const path = require('node:path');
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  const block = page.match(/const ASSET_LIST_GROUPS = \[([\s\S]*?)\n\];/);
  assert.ok(block, 'the groups should be one named list');

  const groups = [...block[1].matchAll(/\{ id:'([a-z]+)',\s*label:'([^']+)',\s*statuses:\[([^\]]*)\]/g)]
    .map((m) => ({
      id: m[1],
      label: m[2],
      statuses: [...m[3].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]),
    }));
  assert.deepStrictEqual(groups.map((g) => g.id), ['active', 'inactive', 'archived']);

  const placed = groups.flatMap((g) => g.statuses);
  assert.deepStrictEqual([...placed].sort(), [...workflow.STATE_IDS].sort(),
    'every status is placed, and nothing is placed that is not a status');
  assert.strictEqual(new Set(placed).size, placed.length, 'and none is placed twice');

  // The grouping the studio asked for, stated so a change to it is deliberate.
  const byId = Object.fromEntries(groups.map((g) => [g.id, g.statuses]));
  assert.deepStrictEqual(byId.inactive, ['not_started'], 'Inactive is Not Assigned');
  assert.deepStrictEqual(byId.archived, ['delivered'],
    'Archived is Delivered — there is no separate "Final" status, and never was');
  assert.ok(!workflow.STATE_IDS.includes('final'), 'nothing in the enum is called final');
});

test('History is a fourth tab and not a fourth slice of the enum', () => {
  /* The tab strip is the status partition plus History, in that order. The
   * distinction matters: History cuts ACROSS the partition — a handed-on asset
   * in TL Review shows in Active and in History both — so it must not be added
   * to ASSET_LIST_GROUPS, where the test above would then find a group with no
   * statuses in it, or worse, statuses claimed twice.
   *
   * Asserted here because the failure is invisible on the page: History given
   * statuses of its own would quietly take them out of Active. */
  const fs = require('node:fs');
  const path = require('node:path');
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  const tabs = page.match(/const ASSET_LIST_TABS = \[([^\]]*(?:\][^;]*?)?)\];/);
  assert.ok(tabs, 'the tab strip should be one named list');
  assert.match(tabs[1], /\.\.\.ASSET_LIST_GROUPS/,
    'the three status tabs should come from the partition itself, not be retyped');
  assert.match(tabs[1], /id:'history'/, 'and History should be appended to them');
  assert.ok(!/statuses:/.test(tabs[1]),
    'History must not claim statuses of its own — it is a cross-cut, not a fourth group');

  // Order on screen: Active, Inactive, Archived, History.
  const groups = page.match(/const ASSET_LIST_GROUPS = \[([\s\S]*?)\n\];/);
  const ids = [...groups[1].matchAll(/\{ id:'([a-z]+)'/g)].map((m) => m[1]);
  assert.deepStrictEqual([...ids, 'history'], ['active', 'inactive', 'archived', 'history']);

  // Membership is decided in one place, for every tab, so the counts cannot
  // disagree with the lists — and it is decided per ROW, which is what puts a
  // handed-on asset's finished rounds in History while its live one stays in
  // Active.
  assert.match(page, /const picked = allRows\.filter\(r=>rowTabOf\(r\)===id\);/,
    'every tab should select rows through rowTabOf, not each with its own rule');
  assert.match(page, /const allRows = listRows\(matching\);/,
    'and the rows should be built once, for every tab');
});

test('every row is in exactly one Assets List tab', () => {
  /* THE tab rule, run as the page runs it.
   *
   * The unit is a ROUND. An asset handed from one person to another has a
   * finished round and a live one, and they belong in different tabs — the
   * closed one in History, the live one wherever its status says. Deciding this
   * per asset put both in History and took live work out of Active with it.
   *
   * Priority order is the specification, so it is asserted as an order. Run
   * against the page's own functions rather than a restatement of them. */
  const fs = require('node:fs');
  const path = require('node:path');
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  const parts = [
    /const ASSET_LIST_GROUPS = \[[\s\S]*?\n\];/,
    /function listGroupOf\(statusId\)\{[\s\S]*?\n\}/,
    /function episodesOf\(a\)\{[^\n]*\}/,
    /const TAB_RULES = \[[\s\S]*?\n\];/,
    /function rowTabOf\(row\)\{[\s\S]*?\n\}/,
    /function listRows\(assets\)\{[\s\S]*?\n\}/,
    /function listTabOf\(a\)\{[^\n]*\}/,
    /function tabAudit\(assets\)\{[\s\S]*?\n\}/,
  ].map((re) => {
    const found = page.match(re);
    assert.ok(found, `could not find ${re} on the page`);
    return found[0];
  });
  // eslint-disable-next-line no-new-func
  const { rowTabOf, listRows, listTabOf, tabAudit, TAB_RULES } =
    new Function(`${parts.join('\n')}; return { rowTabOf, listRows, listTabOf, tabAudit, TAB_RULES };`)();

  assert.deepStrictEqual(TAB_RULES.map((r) => r.id), ['history', 'inactive', 'archived', 'active'],
    'History is checked first and Active last — the order IS the rule');

  const open = () => ({ id: 'live', active: true, endedAt: null });
  const closed = (n) => ({ id: `r${n}`, active: false, endedAt: `2026-0${n}-01T09:00:00Z` });
  const asset = (status, eps) => ({ id: 'a1', code: 'CHR-001', status, assignments: eps });

  // --- one row per round, plus one for where the asset is now -------------
  assert.strictEqual(listRows([asset('in_progress', [])]).length, 1,
    'never assigned: one row');
  assert.strictEqual(listRows([asset('in_progress', [open()])]).length, 1,
    'one live round: one row');
  assert.strictEqual(listRows([asset('in_progress', [closed(1), open()])]).length, 2,
    'handed on once: the closed round and the live one');
  assert.strictEqual(listRows([asset('in_progress', [closed(1), closed(2), open()])]).length, 3,
    'handed on twice: three rows');
  // Taken off somebody and given to nobody: the live row still exists, or the
  // asset would vanish from the board it needs picking up from.
  const orphan = listRows([asset('assigned', [closed(1)])]);
  assert.strictEqual(orphan.length, 2);
  assert.strictEqual(orphan.filter((r) => rowTabOf(r) === 'history').length, 1);
  assert.strictEqual(orphan.filter((r) => rowTabOf(r) !== 'history').length, 1);

  // --- a closed round is History whatever the asset's status is now -------
  for (const status of workflow.STATE_IDS) {
    assert.strictEqual(rowTabOf({ a: asset(status, []), ep: closed(1) }), 'history',
      `a finished round on a ${status} asset belongs in History`);
  }

  // --- the live round goes by status, exactly as before -------------------
  for (const status of workflow.STATE_IDS) {
    const expected = status === 'not_started' ? 'inactive' : status === 'delivered' ? 'archived' : 'active';
    assert.strictEqual(rowTabOf({ a: asset(status, [open()]), ep: open() }), expected,
      `a live round on a ${status} asset`);
    assert.strictEqual(rowTabOf({ a: asset(status, []), ep: null }), expected,
      `${status} with no round at all`);
  }

  // --- the studio's own worked example ------------------------------------
  const handed = asset('in_progress', [closed(1), open()]);
  const rows = listRows([handed]);
  assert.deepStrictEqual(rows.map(rowTabOf), ['history', 'active'],
    'A\'s finished round in History, B\'s live round in Active — at the same time');

  // The asset-level answer is its LIVE round, for anything asking about assets.
  assert.strictEqual(listTabOf(handed), 'active');

  // --- and every combination lands somewhere, exactly once ----------------
  const every = [];
  for (const status of workflow.STATE_IDS) {
    every.push(asset(status, []), asset(status, [open()]),
      asset(status, [closed(1), open()]), asset(status, [closed(1), closed(2), open()]));
  }
  const report = tabAudit(every);
  assert.deepStrictEqual(report.problems, [], 'no row lands in zero tabs or in several');
  assert.ok(report.sums, 'and the four counts add up to the number of ROWS');
  // 1 + 1 + 2 + 3 rows per status.
  assert.strictEqual(report.total, workflow.STATE_IDS.length * 7);
  assert.strictEqual(report.assets, workflow.STATE_IDS.length * 4);
  // Three closed rounds per status, all of them in History.
  assert.strictEqual(report.counts.history, workflow.STATE_IDS.length * 3);
});

test('an asset counts as handed on only once it has actually changed hands', () => {
  /* The rule is one line on the page, and getting it wrong is not visible:
   * off by one either way and History lists every assigned asset in the studio,
   * or none of them. Extracted and run here against the episode shapes
   * src/assignments.js produces. */
  const fs = require('node:fs');
  const path = require('node:path');
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  const src = page.match(/function episodesOf\(a\)\{[\s\S]*?\nfunction lastHandoverAt\(a\)\{[\s\S]*?\n\}/);
  assert.ok(src, 'the handed-on rule should be findable as named functions');
  // eslint-disable-next-line no-new-func
  const { handedOn, lastHandoverAt } = new Function(`${src[0]}; return { handedOn, lastHandoverAt };`)();

  const ep = (at) => ({ assignedAt: at });
  assert.strictEqual(handedOn({}), false, 'an asset with no history has not been handed on');
  assert.strictEqual(handedOn({ assignments: [] }), false, 'nor one never assigned');
  assert.strictEqual(handedOn({ assignments: [ep('2026-01-01T09:00:00Z')] }), false,
    'a first assignment is not a handover — this is the one that would flood the tab');
  assert.strictEqual(handedOn({ assignments: [ep('2026-01-01T09:00:00Z'), ep('2026-01-02T09:00:00Z')] }), true,
    'a second episode means it went to somebody else');

  // The sort key is the LAST handover, not the first assignment and not the
  // most recent episode's end.
  const twice = { assignments: [ep('2026-01-01T09:00:00Z'), ep('2026-01-02T09:00:00Z'), ep('2026-03-04T15:30:00Z')] };
  assert.strictEqual(lastHandoverAt(twice), Date.parse('2026-03-04T15:30:00Z'));
  assert.strictEqual(lastHandoverAt({ assignments: [ep('2026-01-01T09:00:00Z')] }), 0,
    'never handed on sorts last, rather than sorting by when it was first assigned');
});

test('every action can say why it was refused, in English', () => {
  /* The refusal builder falls back to the action id read as words, which is
   * ungrammatical for every action it has ever been asked about: "An asset in
   * \"In Progress\" cannot be deliver." Four were falling through to it, and
   * nobody noticed while the only way to see one was an illegal move on a
   * single asset. Delivering in bulk puts a reason on screen per asset, so a
   * missing entry is now read by whoever pressed the button.
   *
   * Every action is asked for from a state it is illegal in, and the sentence
   * is checked for the fallback's fingerprint: the bare action id. */
  const actions = [...new Set(workflow.TRANSITIONS.map((t) => t.action))];
  const ctx = (status) => ({
    user: { id: 'u1', role: 'super_admin' },
    asset: { status, assignee_id: 'u1', routed_to_id: null },
    isTeamLead: true, canOverride: true, canEdit: true, canAssign: true,
    canDeliver: true, canHandOver: true, canReviewCd: true,
    canApproveForClient: true, canSendToClient: true,
  });

  for (const action of actions) {
    const legal = workflow.transitionFor(action).from;
    // EVERY illegal state, not just the first: some actions have a
    // purpose-written message for one state — "Start the work before
    // submitting it" — which would otherwise hide a fallback for another.
    for (const illegal of workflow.STATE_IDS.filter((s) => !legal.includes(s))) {
      const verdict = workflow.evaluate(action, ctx(illegal), { note: 'x' });
      assert.strictEqual(verdict.ok, false, `${action} should be illegal from ${illegal}`);
      assert.ok(verdict.error && verdict.error.trim(), `${action} from ${illegal} said nothing`);
      // The fallback's fingerprint: the sentence ends with the bare action id.
      assert.ok(!verdict.error.endsWith(`cannot be ${action.replace(/_/g, ' ')}.`),
        `${action} has no phrase of its own, so from ${illegal} it reads "${verdict.error}" `
        + '— add one to PHRASE in src/asset-workflow.js');
    }
  }
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

test('CD Feedbacks is not the assignee\'s until the lead passes it on', () => {
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

    const accepted = await call(`/assets/${id}/start`, { token: token.artist, method: 'POST' });
    assert.strictEqual(accepted.status, 200, JSON.stringify(accepted.body));
    assert.strictEqual(accepted.body.accepted, true);
    assert.strictEqual(accepted.body.asset.status, 'in_progress');
    assert.strictEqual(accepted.body.work.open, true, 'and the start is stamped');
    assert.ok(accepted.body.work.startedAt, 'with the moment it was stamped at');
    assert.strictEqual(accepted.body.work.submittedAt, null, 'and nothing submitted yet');

    const events = await historyOf(id);
    assert.deepStrictEqual(events.map((e) => e.action), ['assign', 'accept']);
    assert.deepStrictEqual(events.map((e) => e.toStatus), ['assigned', 'in_progress']);
  });

  await t.test('Send to Client: the lead skips the CD gate, and the history says so', async () => {
    /* The permission split, against a live server. `team_lead` does not hold
       review.tl_send_client by default, so the same account is used before and
       after the grant — which is the case the studio will actually meet. */
    const toReview = async (name) => {
      const id = await newAsset(name);
      await call(`/assets/${id}/start`, { token: token.artist, method: 'POST' });
      await act(id, 'submit', 'artist', { link: 'http://nas/shots/' + name.replace(/\W+/g, '-') });
      assert.strictEqual(await statusOf(id), 'pending_tl_review');
      return id;
    };
    const relogin = async () => { token.lead = (await call('/auth/login',
      { method: 'POST', body: { email: 'tl@zvky.test', password: PASSWORD } })).body.token; };

    // --- without the permission -------------------------------------------
    const denied = await toReview('No Skip For You');
    const refused = await act(denied, 'send-to-client', 'lead');
    assert.strictEqual(refused.status, 403,
      `TL Review Actions alone must not reach it — got ${JSON.stringify(refused.body)}`);
    assert.strictEqual(await statusOf(denied), 'pending_tl_review', 'and nothing moved');

    // The ordinary two are unaffected: this lead still reviews exactly as before.
    assert.strictEqual((await act(denied, 'review', 'lead', { decision: 'approved' })).status, 200);
    assert.strictEqual(await statusOf(denied), 'pending_cd_review');

    // --- with the permission ----------------------------------------------
    const grant = await call('/permissions/roles/team_lead', {
      token: token.admin, method: 'PUT', body: { permissions: ['review.tl', 'review.tl_send_client'] },
    });
    assert.strictEqual(grant.status, 200, JSON.stringify(grant.body));
    await relogin();

    const id = await toReview('Straight To The Client');
    const sent = await act(id, 'send-to-client', 'lead', { text: 'Client signed off on the concept already' });
    assert.strictEqual(sent.status, 200, JSON.stringify(sent.body));
    assert.strictEqual(sent.body.asset.status, 'approved_for_client',
      'the same state the CD route reaches');
    assert.strictEqual(await statusOf(id), 'approved_for_client');

    /* The audit trail, which is the point of requirement 2: a distinct action,
       the person, the moment, and the two states it moved between. */
    const events = await historyOf(id);
    const skip = events[events.length - 1];
    assert.strictEqual(skip.action, 'tl_send_to_client',
      'recorded under its own action, not as an ordinary approval');
    assert.strictEqual(skip.fromStatus, 'pending_tl_review');
    assert.strictEqual(skip.toStatus, 'approved_for_client');
    assert.strictEqual(skip.actor, 'Priya Menon', 'who did it');
    assert.ok(skip.at, 'and when');
    assert.match(skip.note, /Client signed off on the concept already/);
    assert.ok(!events.some((e) => e.action === 'cd_approve'),
      'and no CD approval was ever recorded, because none happened');
    assert.ok(!events.some((e) => e.toStatus === 'pending_cd_review'),
      'the asset never entered CD Review at all');

    /* Countable, which is what "how often does TL skip CD review" needs. Both
       routes reach approved_for_client, so the status cannot answer it and the
       action has to. */
    const skipped = await sql(cfg,
      "SELECT COUNT(*) AS n FROM asset_events WHERE action = 'tl_send_to_client'");
    assert.ok(Number(skipped[0].n) >= 1, 'the skip is queryable across the whole studio');

    // Delivered still works from there — the end of the pipeline is unchanged.
    assert.strictEqual((await act(id, 'deliver', 'admin')).status, 200);
    assert.strictEqual(await statusOf(id), 'delivered');

    // --- and it is only reachable from TL Review ---------------------------
    const inCd = await toReview('Already Past The Lead');
    await act(inCd, 'review', 'lead', { decision: 'approved' });
    assert.strictEqual(await statusOf(inCd), 'pending_cd_review');
    assert.strictEqual((await act(inCd, 'send-to-client', 'lead')).status, 409,
      'no second bite once it is in the CD queue');

    // The artist cannot reach it whatever the lead holds.
    const mine = await toReview('Not The Artists Call');
    assert.strictEqual((await act(mine, 'send-to-client', 'artist')).status, 403);

    await call('/permissions/roles/team_lead/reset', { token: token.admin, method: 'POST' });
    await relogin();
  });

  await t.test('the happy path runs end to end', async () => {
    const id = await newAsset('Hero Character');
    assert.strictEqual(await statusOf(id), 'assigned', 'created with an assignee waits to be accepted');

    assert.strictEqual((await call(`/assets/${id}/start`, { token: token.artist, method: 'POST' })).status, 200);
    assert.strictEqual(await statusOf(id), 'in_progress');
    await act(id, 'start', 'artist');
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
    await act(id, 'start', 'artist');
    await act(id, 'submit', 'artist', { link: 'https://review.example.com/v1' });

    const rejected = await act(id, 'review', 'lead',
      { decision: 'changes_requested', text: 'Silhouette reads flat.' });
    assert.strictEqual(rejected.status, 200);
    assert.strictEqual(rejected.body.asset.status, 'tl_changes_requested');
    assert.strictEqual(rejected.body.asset.routed_to_id, people.artist, 'routed back to the assignee');

    await act(id, 'start', 'artist');
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
      ['assign', 'accept', 'submit', 'tl_request_changes', 'submit']);
    assert.strictEqual(events[3].note, 'Silhouette reads flat.', 'the feedback is in the trail');
  });

  await t.test('a CD-changes round goes to the lead, who relays it', async () => {
    const id = await newAsset('Sidekick');
    await act(id, 'start', 'artist');
    await act(id, 'submit', 'artist', { link: 'https://review.example.com/s1' });
    await act(id, 'review', 'lead', { decision: 'approved' });

    const rejected = await act(id, 'review', 'cd',
      { decision: 'changes_requested', text: 'Palette is off-brief.' });
    assert.strictEqual(rejected.body.asset.status, 'cd_changes_requested');
    assert.strictEqual(rejected.body.asset.routed_to_id, null, 'with the lead, not the artist');

    // The artist cannot pick it up before the lead has briefed them.
    await act(id, 'start', 'artist');
    const early = await act(id, 'submit', 'artist', { link: 'https://review.example.com/s2' });
    assert.strictEqual(early.status, 403);
    assert.match(early.body.error, /team lead has not passed/i);

    const relayed = await act(id, 'relay', 'lead', { text: 'Cooler palette please.' });
    assert.strictEqual(relayed.status, 200);
    assert.strictEqual(relayed.body.asset.status, 'cd_changes_requested', 'the relay does not move the status');
    assert.strictEqual(relayed.body.asset.routed_to_id, people.artist, 'only whose desk it is on');

    // Default re-entry is the lead, who relayed it.
    await act(id, 'start', 'artist');
    const resubmitted = await act(id, 'submit', 'artist',
      { link: 'https://review.example.com/s2', description: 'Cooled it.' });
    assert.strictEqual(resubmitted.status, 201);
    assert.strictEqual(await statusOf(id), 'pending_tl_review');

    assert.deepStrictEqual((await historyOf(id)).map((e) => e.action),
      ['assign', 'accept', 'submit', 'tl_approve', 'cd_request_changes', 'relay', 'submit']);
  });

  await t.test('permission is enforced at every gate, by the API', async () => {
    const id = await newAsset('Guarded Prop');

    // Only the assignee submits — asked from In Progress, where submitting is
    // otherwise legal, so the answer is about who is asking rather than about
    // the state. From Assigned every submission is refused for being too early,
    // whoever sends it, and that would say nothing about permission.
    await act(id, 'start', 'artist');
    const wrongArtist = await act(id, 'submit', 'other', { link: 'https://review.example.com/x' });
    assert.strictEqual(wrongArtist.status, 403);
    assert.match(wrongArtist.body.error, /assigned/i);

    await act(id, 'submit', 'artist', { link: 'https://review.example.com/g1' });

    // Not the artist, at the TL gate.
    const own = await act(id, 'review', 'artist', { decision: 'approved' });
    assert.strictEqual(own.status, 403, 'nobody reviews their own submission');
    assert.match(own.body.error, /team lead/i);

    // The Creative Director CAN act here now, and that is a consequence of the
    // studio's own decision rather than an accident: review.tl belongs to every
    // role in Supervision, Creative Direction and Production, and Creative
    // Direction is where the CD sits. It widens who may clear the first gate —
    // it does not let anyone skip it.
    const director = await act(id, 'review', 'cd', { decision: 'approved' });
    assert.strictEqual(director.status, 200, 'the CD holds review.tl through their department');
    assert.strictEqual(await statusOf(id), 'pending_cd_review', 'and it still lands at the CD gate');

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
    await act(id, 'start', 'artist');
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
    await act(id, 'start', 'artist');
    await act(id, 'submit', 'artist', { link: 'http://nas/a' });
    await act(id, 'review', 'lead', { decision: 'changes_requested', text: 'again' });
    await act(id, 'start', 'artist');
    await act(id, 'submit', 'artist', { link: 'http://nas/b' });
    await act(id, 'review', 'lead', { decision: 'approved' });
    await act(id, 'review', 'cd', { decision: 'approved' });

    const events = await historyOf(id);
    assert.deepStrictEqual(events.map((e) => e.action),
      ['assign', 'accept', 'submit', 'tl_request_changes', 'submit', 'tl_approve', 'cd_approve']);
    // Each event says where it came from and where it went. Accepting is in the
    // chain now: work has to be started before it can be handed in, so the step
    // out of Assigned is always recorded.
    assert.deepStrictEqual(events.map((e) => e.toStatus), [
      'assigned', 'in_progress', 'pending_tl_review', 'tl_changes_requested',
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

test('who sees which dashboard column', () => {
  /* The bug: the CD stages were gated on asset.add, which asks "can you set
     work up". A Creative Art Director holds review.cd and NOT asset.add, so
     the two columns their permission is entirely about were the two they could
     not see — column and stats tile together.

     This runs the page's own visibleStatuses() against three permission sets,
     so the rule is checked rather than the list it happens to be written in. */
  const fs = require('fs');
  const path = require('path');
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

  const grab = (name, opener) => {
    const at = page.indexOf(opener);
    assert.ok(at !== -1, `could not find ${name} in the page`);
    const rest = page.slice(at);
    return rest.slice(0, rest.indexOf('\n}') + 2);
  };
  const source = grab('RESTRICTED_STATUSES', 'const RESTRICTED_STATUSES = [')
    + '\n' + grab('visibleStatuses', 'function visibleStatuses()');

  const STATUSES = workflow.STATE_IDS.map((id) => ({ id }));
  const build = (held) => new Function('STATUSES', 'can',
    `${source}; return visibleStatuses;`)(STATUSES, (p) => held.includes(p));

  const seen = (held) => build(held)().map((s) => s.id);

  const cd = seen(['review.cd']);                 // Creative Art Director
  const planner = seen(['asset.add']);            // Team Lead, Producer …
  const neither = seen([]);                       // Game Artist
  const both = seen(['asset.add', 'review.cd']);

  for (const id of ['pending_cd_review', 'cd_changes_requested']) {
    assert.ok(cd.includes(id), `a CD reviewer must see ${id}`);
    assert.ok(planner.includes(id), `${id} must stay visible to whoever sets work up`);
    assert.ok(!neither.includes(id), `${id} must stay hidden from a role holding neither`);
  }

  // Not Assigned deliberately did NOT change: acting on that queue means
  // putting somebody on it, which reviewing does not.
  assert.ok(planner.includes('not_started'));
  assert.ok(!cd.includes('not_started'), 'reviewing is not a reason to see the unassigned queue');
  assert.ok(!neither.includes('not_started'));

  /* Work that is out with the client is its own gate, held by neither of the
     two above: watching that column is a separate grant from acting on it, and
     from anything to do with the CD stages. */
  const watcher = seen(['review.client_view']);
  assert.ok(watcher.includes('awaiting_client_feedback'), 'the view permission shows the column');
  assert.ok(!cd.includes('awaiting_client_feedback'), 'reviewing at the CD gate does not');
  assert.ok(!planner.includes('awaiting_client_feedback'), 'nor does setting work up');
  assert.ok(!neither.includes('awaiting_client_feedback'));

  // Nothing regressed for the case that already worked.
  const everything = seen(['asset.add', 'review.cd', 'review.client_view']);
  assert.deepStrictEqual(everything, workflow.STATE_IDS, 'holding all three should show every stage');
  // And every stage outside the restricted list is everybody's business.
  const RESTRICTED = ['not_started', 'pending_cd_review', 'cd_changes_requested', 'awaiting_client_feedback'];
  for (const id of workflow.STATE_IDS) {
    if (RESTRICTED.includes(id)) continue;
    assert.ok(neither.includes(id), `${id} should be visible to everyone`);
  }
  assert.deepStrictEqual(both, workflow.STATE_IDS.filter((id) => id !== 'awaiting_client_feedback'),
    'and the CD/planner pair still sees everything except the client column');
});

/* --- Send to Client: the team lead skipping the CD gate ---------------------
 *
 * The permission split is the whole feature, so it is tested as a truth table
 * rather than on the happy path alone: standing at the TL gate and the
 * authority to skip the next one are two different things, and the button must
 * appear only where both are held.
 */
test('Send to Client needs the TL gate AND the permission to skip the CD one', () => {
  const at = (status) => ({
    user: { id: 'lead-1', role: 'team_lead' },
    asset: { status, assignee_id: 'artist-1' },
  });
  const verdict = (extra, status = 'pending_tl_review') =>
    workflow.evaluate('tl_send_to_client', { ...at(status), ...extra });

  assert.strictEqual(verdict({ isTeamLead: true, canSendToClient: true }).ok, true,
    'both halves held');
  assert.strictEqual(verdict({ isTeamLead: true, canSendToClient: false }).ok, false,
    'TL Review Actions alone is not enough — that is the point of the split');
  assert.strictEqual(verdict({ isTeamLead: false, canSendToClient: true }).ok, false,
    'nor is the permission on its own, without standing at the TL gate');
  assert.strictEqual(verdict({ isTeamLead: false, canSendToClient: false }).ok, false);

  // Full access reaches it, as it reaches every other gate.
  assert.strictEqual(verdict({ isTeamLead: false, canOverride: true, canSendToClient: true }).ok, true);

  // Only from TL Review. Not from the CD queue, not from rework, not after the
  // fact — there is no second bite once the asset is past this gate.
  for (const status of ['not_started', 'assigned', 'in_progress', 'tl_changes_requested',
                        'pending_cd_review', 'cd_changes_requested',
                        'approved_for_client', 'delivered']) {
    assert.strictEqual(verdict({ isTeamLead: true, canSendToClient: true }, status).ok, false,
      `Send to Client must not be reachable from ${status}`);
  }
});

test('Send to Client lands where the CD route lands, by a distinguishable action', () => {
  const send = workflow.evaluate('tl_send_to_client', {
    user: { id: 'lead-1', role: 'team_lead' },
    asset: { status: 'pending_tl_review', assignee_id: 'artist-1' },
    isTeamLead: true, canSendToClient: true,
  });
  const cd = workflow.evaluate('cd_approve', {
    user: { id: 'cd-1', role: 'art_director' },
    asset: { status: 'pending_cd_review', assignee_id: 'artist-1' },
    canReviewCd: true, canApproveForClient: true,
  });

  /* Same destination, deliberately: reusing approved_for_client is what keeps
     the dashboard columns, the stats bar and the Delivered flow working with no
     knowledge of this feature at all. */
  assert.strictEqual(send.to, 'approved_for_client');
  assert.strictEqual(send.to, cd.to, 'both routes reach the same state');
  assert.strictEqual(send.routedTo, cd.routedTo, 'and sit in the same queue');

  /* But NOT the same action. The action id is what asset_events stores, so
     "how often does a lead skip the CD" stays answerable from history already
     written, without a column being added for it later. */
  assert.notStrictEqual(send.action, cd.action);
  assert.strictEqual(send.action, 'tl_send_to_client');
  assert.match(send.describe, /skipping Creative Director review/);

  // And Delivered is still reachable from there, by the ordinary route.
  const deliver = workflow.evaluate('deliver', {
    user: { id: 'p-1', role: 'producer' },
    asset: { status: send.to, assignee_id: 'artist-1' },
    canDeliver: true,
  });
  assert.strictEqual(deliver.ok, true, 'the Delivered flow is untouched');
  assert.strictEqual(deliver.to, 'delivered');
});

test('the TL Send to Client permission is its own key, off by default', () => {
  const catalog = require('../src/permission-catalog');
  const { activeRoles, roleDef } = require('../src/roles');
  const all = catalog.GROUPS.flatMap((g) => g.permissions);

  const perm = all.find((p) => p.key === 'review.tl_send_client');
  assert.ok(perm, 'the permission exists');
  assert.strictEqual(perm.label, 'TL Send to Client');

  // In the Review Workflow group, beside the permissions it relates to.
  const group = catalog.GROUPS.find((g) => g.permissions.some((p) => p.key === 'review.tl_send_client'));
  assert.strictEqual(group.label, 'Review Workflow');

  /* Independent of the two it is easiest to confuse it with. review.tl is
     standing at the TL gate; review.approve_client is signing off while
     standing IN the CD gate; this is the authority to walk around it. */
  const holders = (key) => {
    const p = all.find((x) => x.key === key);
    return activeRoles().map((r) => r.key).filter((k) => {
      const def = roleDef(k);
      return def && p.impliedBy(def);
    });
  };
  const skip = holders('review.tl_send_client');
  const tl = holders('review.tl');

  assert.ok(skip.includes('super_admin'), 'Super Admin has it by default');
  assert.ok(skip.length > 1, 'and so do the other full-access roles');
  assert.ok(!skip.includes('team_lead'),
    'but an ordinary Team Lead does NOT — bypassing the CD gate is granted deliberately');
  assert.ok(tl.includes('team_lead'),
    'while a Team Lead still holds TL Review Actions, so they review exactly as before');
  assert.ok(tl.length > skip.length,
    'the skip permission reaches strictly fewer roles than the review one');
});

test('every workflow action has a name the history can show', () => {
  /* An action missing from HISTORY_ACTIONS falls back to its raw id, so the
     asset's history showed "accept" and "reassign_review" as bare code names
     beside properly worded lines. Adding a transition without a label is the
     easy way to reintroduce that, so the two lists are checked against each
     other rather than kept in step by memory. */
  const fs = require('node:fs');
  const path = require('node:path');
  const page = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const block = page.match(/const HISTORY_ACTIONS = \{([\s\S]*?)\n\};/);
  assert.ok(block, 'public/index.html has no HISTORY_ACTIONS map');
  const labelled = [...block[1].matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]);

  const actions = [...new Set(workflow.TRANSITIONS.map((t) => t.action))];
  const missing = actions.filter((a) => !labelled.includes(a));
  assert.deepStrictEqual(missing, [],
    `these actions would appear in the history as raw ids: ${missing.join(', ')}`);
});

/* --- refusals have to say which thing is wrong ------------------------------
 *
 * refusal() switches on transition.who, and an actor with no case falls to
 * "You cannot do that to this asset." — true, useless, and indistinguishable
 * from a bug. That is what happened: tl_send_to_client added an actor and not
 * a case, so a lead clicking a button the page had offered them was told
 * nothing about whether it was their permissions or the asset.
 */
test('every actor explains its own refusal', () => {
  const GENERIC = 'You cannot do that to this asset.';
  const actors = [...new Set(workflow.TRANSITIONS.map((t) => t.who))];

  /* Refuse each transition by handing it a context where nobody can do
     anything, and check the message is specific to that gate. */
  const vague = [];
  for (const t of workflow.TRANSITIONS) {
    const verdict = workflow.evaluate(t.action, {
      user: { id: 'nobody', role: 'game_artist' },
      asset: { status: t.from[0], assignee_id: 'someone-else', project_id: 'p' },
    });
    assert.strictEqual(verdict.ok, false, `${t.action} should refuse a stranger`);
    if (verdict.error === GENERIC) vague.push(`${t.action} (actor: ${t.who})`);
  }
  assert.deepStrictEqual(vague, [],
    `these refuse with the generic message instead of naming the gate: ${vague.join(', ')}`);

  // And stated directly, so adding an actor without a case fails here too.
  const src = require('node:fs').readFileSync(
    require('node:path').join(__dirname, '..', 'src', 'asset-workflow.js'), 'utf8');
  const body = src.match(/function refusal\(transition, ctx\) \{([\s\S]*?)\n\}/)[1];
  const cased = [...body.matchAll(/case '([a-zA-Z]+)':/g)].map((m) => m[1]);
  const missing = actors.filter((a) => !cased.includes(a));
  assert.deepStrictEqual(missing, [],
    `these actors have no case in refusal() and would fall to the generic message: ${missing.join(', ')}`);
});

test('Send to Client says which of the two things is wrong', () => {
  const base = {
    user: { id: 'lead-1', role: 'team_lead' },
    asset: { status: 'pending_tl_review', assignee_id: 'artist-1' },
  };

  // Missing the permission — fixable in Settings, and the message says where.
  const noPerm = workflow.evaluate('tl_send_to_client', { ...base, isTeamLead: true, canSendToClient: false });
  assert.strictEqual(noPerm.status, 403);
  assert.match(noPerm.error, /do not have permission/i);
  assert.match(noPerm.error, /TL Send to Client/, 'naming the permission to grant');

  // Has it, but it is somebody else's artist — not fixable in Settings at all,
  // so the message must not send them looking there.
  const notTheirLead = workflow.evaluate('tl_send_to_client', { ...base, isTeamLead: false, canSendToClient: true });
  assert.strictEqual(notTheirLead.status, 403);
  assert.match(notTheirLead.error, /own team lead/i);
  assert.ok(!/permission/i.test(notTheirLead.error),
    'and does not blame permissions, which are not the problem here');

  // Wrong state — a different status code, and it names the state required.
  for (const status of ['tl_changes_requested', 'pending_cd_review', 'approved_for_client']) {
    const wrongState = workflow.evaluate('tl_send_to_client', {
      ...base, asset: { ...base.asset, status }, isTeamLead: true, canSendToClient: true,
    });
    assert.strictEqual(wrongState.status, 409, `${status} is a state problem, not a permission one`);
    assert.match(wrongState.error, /TL Review/, 'naming the state it has to be in');
    assert.ok(!/tl send to client/.test(wrongState.error),
      'and reading as a sentence rather than as the raw action id');
  }
});
