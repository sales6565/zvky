#!/usr/bin/env node
/* Sample data, for looking at a working app.
 *
 *   npm run sample:data
 *
 * ADDITIVE and namespaced. Everything it writes hangs off one client called
 * "Sample Studio Data", so nothing existing is touched and the whole lot can be
 * removed again by archiving or deleting that client. It refuses to run twice
 * rather than doubling up.
 *
 * What it exists for: the seed writes assets with estimates but no work
 * sessions, so the Reports tab correctly showed every asset as "no tracked
 * time" — a working report with nothing to report on. This writes the sessions
 * too, with rounds, rework and a handover, so every screen has something
 * truthful to draw:
 *
 *   Dashboard      assets across the pipeline
 *   Assets List    all three sub-tabs populated
 *   Reports        a spread of efficiency, including one category that is
 *                  consistently over budget so the outlier flag has something
 *                  to flag
 *
 * The numbers are chosen, not random: re-running on a fresh database gives the
 * same report, so a screenshot means the same thing tomorrow.
 */

require('dotenv').config();
const { v4: uuid } = require('uuid');
const bcrypt = require('bcryptjs');
const db = require('../src/db');
const referenceData = require('../src/reference-data');
const userProject = require('../src/user-project');

const CLIENT_NAME = 'Sample Studio Data';
const PASSWORD = process.env.SAMPLE_PASSWORD || 'Sample-Pass-1!';

// hours -> seconds
const H = (hours) => Math.round(hours * 3600);

/* The assets. Each line is one asset and the story of how it went.
 *
 *   est     the Man Hours estimate
 *   first   hours actually spent before the first submission
 *   rework  hours spent after it came back, 0 if it never did
 *
 * Slot Game work comes in under estimate; Table Game work consistently runs
 * over, which is what makes it an outlier the Reports tab points at.
 */
const ASSETS = [
  // name,                who,    category,     scope,        est, first, rework, end
  ['Reel Frame',          'anya', 'Slot Game',  'prop',        10,   5,     0, 'delivered'],
  ['Reel Symbols',        'anya', 'Slot Game',  'character',    8,   6,     0, 'delivered'],
  ['Big Win Burst',       'anya', 'Slot Game',  'fx',          12,   9,     0, 'approved'],
  ['Bonus Wheel',         'anya', 'Slot Game',  'prop',        10,   8,     4, 'delivered'],
  ['Free Spins Backdrop', 'omar', 'Slot Game',  'background',  14,  11,     0, 'cd_review'],

  ['Card Table',          'omar', 'Table Game', 'prop',        10,  20,     0, 'delivered'],
  ['Dealer Rig',          'omar', 'Table Game', 'character',    8,  16,     0, 'delivered'],
  ['Chip Stack',          'omar', 'Table Game', 'prop',         6,  15,     0, 'approved'],
  ['Felt Texture',        'omar', 'Table Game', 'background',   5,  11,     3, 'tl_changes'],

  ['Lobby Loop',          'priya', 'Marketing', 'animation',    9,   9,     0, 'delivered'],
  ['Promo Banner',        'priya', 'Marketing', 'background',   4,   3,     0, 'tl_review'],
  ['Teaser Cut',          'priya', 'Marketing', 'animation',   16,  14,     2, 'delivered'],

  // Never started: gives the Assets List an Inactive tab with something in it,
  // and the Reports tab an excluded row with a stated reason.
  ['Concept Sketches',    null,    'Marketing', 'character',    6,   0,     0, 'not_started'],
];

const PEOPLE = [
  ['Anya Sorensen', 'anya',  'game_artist'],
  ['Omar Haddad',   'omar',  'game_artist'],
  ['Priya Nair',    'priya', 'game_artist'],
];

async function one(sql, params) {
  const { rows } = await db.query(sql, params);
  return rows[0] || null;
}

async function main() {
  await referenceData.load(db);

  const existing = await one('SELECT id FROM clients WHERE `name` = $1', [CLIENT_NAME]);
  if (existing) {
    console.log(`"${CLIENT_NAME}" already exists — nothing written.`);
    console.log('Delete or archive that client first if you want a fresh set.');
    return;
  }

  const admin = await one("SELECT id FROM users WHERE `role` = 'super_admin' ORDER BY created_at LIMIT 1");
  if (!admin) {
    console.error('No Super Admin account exists yet. Run "npm run seed" or bootstrap one first.');
    process.exitCode = 1;
    return;
  }

  const lead = await one("SELECT id FROM users WHERE `role` = 'team_lead' ORDER BY created_at LIMIT 1");

  // --- the categories the sample uses, if the studio has not made them ------
  const categoryKey = {};
  for (const label of ['Slot Game', 'Table Game', 'Marketing']) {
    const already = referenceData.list('categories', { includeInactive: true })
      .find((c) => c.label.toLowerCase() === label.toLowerCase());
    if (already) { categoryKey[label] = already.key; continue; }
    const made = await referenceData.create(db, 'categories', { label });
    if (!made.ok) throw new Error(`Could not add the "${label}" category: ${JSON.stringify(made.errors)}`);
    categoryKey[label] = made.entry.key;
    console.log(`  category added: ${label}`);
  }

  const client = uuid();
  await db.query('INSERT INTO clients (id, `name`, notes, created_by) VALUES ($1,$2,$3,$4)',
    [client, CLIENT_NAME, 'Everything under this client was written by scripts/sample-data.js. Safe to delete.', admin.id]);

  const project = uuid();
  await db.query('INSERT INTO projects (id, `name`, `code`, owner_id, client_id) VALUES ($1,$2,$3,$4,$5)',
    [project, 'Sample Slot Project', 'SAMPLE', admin.id, client]);
  if (lead) {
    await db.query('INSERT INTO project_team_leads (project_id, user_id) VALUES ($1,$2)', [project, lead.id]);
  }
  console.log(`  client + project created: ${CLIENT_NAME} / Sample Slot Project`);

  // --- the people -----------------------------------------------------------
  const hash = await bcrypt.hash(PASSWORD, 10);
  const userId = {};
  for (const [name, handle, role] of PEOPLE) {
    const email = `${handle}@sample.zvky.test`;
    const found = await one('SELECT id FROM users WHERE email = $1', [email]);
    if (found) { userId[handle] = found.id; continue; }
    const id = uuid();
    await db.query(
      'INSERT INTO users (id, `name`, email, password_hash, `role`, manager_id, team_lead_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
      [id, name, email, hash, role, admin.id, lead ? lead.id : null]
    );
    /* Project membership is a join table per side of the project, not a column
       on users — so use the app's own helper rather than a second idea of what
       "on a project" means. */
    await userProject.setProject(db, id, project, role);
    userId[handle] = id;
    console.log(`  artist created: ${name} <${email}>`);
  }

  // --- the assets, with the work that went into them ------------------------
  const STATUS = {
    not_started: 'not_started', tl_review: 'pending_tl_review', tl_changes: 'tl_changes_requested',
    cd_review: 'pending_cd_review', approved: 'approved_for_client', delivered: 'delivered',
  };
  const prefixOf = (scope) => {
    const entry = referenceData.get('asset_types', scope);
    return entry ? entry.codePrefix : 'AST';
  };
  const counters = {};

  for (const [name, who, category, scope, est, first, rework, end] of ASSETS) {
    const status = STATUS[end];
    const assignee = who ? userId[who] : null;
    counters[scope] = (counters[scope] || 0) + 1;
    const code = `${prefixOf(scope)}-${String(counters[scope]).padStart(3, '0')}`;
    const id = uuid();

    await db.query(
      'INSERT INTO assets (id, `code`, `name`, `type`, category, `status`, priority, project_id, assignee_id, created_by, man_hours, description) '
      + 'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [id, code, name, scope, categoryKey[category], status, 'med', project, assignee, admin.id, est,
       'Sample data — safe to delete with its client.']
    );

    // A checklist, so the asset panel is not empty.
    ['Rough pass', 'Clean line', 'Colour / shade'].forEach(() => {});
    let position = 0;
    for (const task of ['Rough pass', 'Clean line', 'Colour / shade']) {
      await db.query('INSERT INTO tasks (id, asset_id, `name`, done, `position`) VALUES ($1,$2,$3,$4,$5)',
        [uuid(), id, task, status === 'delivered' ? 1 : 0, position++]);
    }

    if (!assignee) continue;

    // The episode this person worked, so the Assets List attributes it.
    await db.query(
      'INSERT INTO asset_assignments (id, asset_id, user_id, assigned_by_id, status_at_assignment) VALUES ($1,$2,$3,$4,$5)',
      [uuid(), id, assignee, admin.id, 'not_started']
    ).catch(() => {});

    /* The work. Round 1 is everything before the first submission — the same
       meaning the timer gives it — and round 2 is the rework, so the Reports
       tab's first-pass and total numbers differ by exactly the rework. */
    if (first > 0) {
      await db.query(
        'INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds) '
        + 'VALUES ($1,$2,$3,1,DATE_SUB(NOW(), INTERVAL 21 DAY),DATE_SUB(NOW(), INTERVAL 21 DAY),$4)',
        [uuid(), id, assignee, H(first)]
      );
    }
    if (rework > 0) {
      await db.query(
        'INSERT INTO work_sessions (id, asset_id, user_id, round, started_at, ended_at, seconds) '
        + 'VALUES ($1,$2,$3,2,DATE_SUB(NOW(), INTERVAL 7 DAY),DATE_SUB(NOW(), INTERVAL 7 DAY),$4)',
        [uuid(), id, assignee, H(rework)]
      );
    }

    /* A submission per round, dated so the Reports trend has more than one
       point on it. An asset is only in the report once it has been submitted,
       so this is what puts it there. */
    const submissions = status === 'not_started' ? 0 : (rework > 0 ? 2 : 1);
    for (let n = 1; n <= submissions; n++) {
      await db.query(
        'INSERT INTO asset_versions (id, asset_id, version_number, stage, link, description, uploaded_by, created_at) '
        + `VALUES ($1,$2,$3,$4,$5,$6,$7,DATE_SUB(NOW(), INTERVAL ${n === 1 ? 21 : 6} DAY))`,
        [uuid(), id, n, 'tl', `https://example.test/${code.toLowerCase()}-v${n}`,
         n === 1 ? 'First pass' : 'Reworked after review', assignee]
      );
    }

    if (status === 'delivered') {
      await db.query(
        'INSERT INTO asset_events (id, asset_id, action, from_status, to_status, actor_id, actor_email, note, created_at) '
        + "VALUES ($1,$2,'deliver','approved_for_client','delivered',$3,$4,$5,DATE_SUB(NOW(), INTERVAL 3 DAY))",
        [uuid(), id, admin.id, 'sample@zvky.test', 'Delivered to the client.']
      ).catch(() => {});
    }
  }

  console.log(`\n  ${ASSETS.length} assets written under "${CLIENT_NAME}".`);
  console.log(`  Sample artists sign in with: ${PASSWORD}`);
  console.log('\n  Reports should now show Table Game averaging well under 100% — that is deliberate,');
  console.log('  so the outlier flag has something to point at. Delete the client to remove all of it.');
}

main()
  .then(() => db.end && db.end())
  .catch((err) => {
    console.error('Sample data failed:', err.sqlMessage || err.message);
    process.exitCode = 1;
  })
  .finally(() => { if (db.end) db.end().catch(() => {}); });
