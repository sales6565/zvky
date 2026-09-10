#!/usr/bin/env node
/* Three clients, three projects, and enough figures for both P&L tabs to mean
 * something on first look.
 *
 * WHY THIS IS A SCRIPT YOU RUN AND NOT A SEED THAT RUNS ITSELF. It writes
 * clients and projects, which are real records in a real studio's database.
 * Anything that creates those on boot will eventually create them on the
 * production instance, on the morning somebody restarts the app to fix
 * something else, and "Northwind Games" will be sitting in the client list
 * during a client meeting. So: run it deliberately, or not at all.
 *
 *   npm run pnl:demo             create the three clients and projects
 *   npm run pnl:demo -- --remove take them away again
 *
 * It is IDEMPOTENT on the client name, so running it twice does not produce six
 * clients. The tag below is written to the CLIENT's notes, and --remove finds
 * demo data by it — nothing is deleted that this script did not create, and a
 * real client that happens to share a name is never touched.
 *
 * THE THREE PROJECTS ARE DELIBERATELY DIFFERENT SHAPES, because two tabs that
 * show the same story on every row demonstrate nothing:
 *
 *   Orbit Rally      healthy. Came in under the planned hours, billed
 *                    everything worked. Good on both tabs.
 *   Nightgarden      OVER BUDGET. Overran the plan badly on the senior roles;
 *                    on a fixed fee that comes straight out of the margin.
 *                    Fixed tab flags it; Actual tab looks unremarkable.
 *   Tidewater        UNDER-BILLED. Hours worked were fine against the plan, but
 *                    a chunk of them was never invoiced. Fixed tab looks fine;
 *                    Actual tab shows the absorbed hours and the thinner
 *                    margin. The pair is the whole argument for two tabs.
 */

require('dotenv').config();
const { v4: uuid } = require('uuid');
const db = require('../src/db');
const pnl = require('../src/pnl');

const TAG = '[pnl-demo]';

/* The rates the demo prices everything at. Applied to the seeded rate card rows
   only where they are still at zero, so a studio that has set its own rates
   does not have them overwritten by a demo script. */
const DEMO_RATES = {
  'Junior Level Artist': 25,
  'Mid Level Artist': 40,
  'Senior Artist': 60,
  'Art Team Lead': 75,
  'Junior Level Animator': 28,
  'Mid Level Animator': 45,
  'Senior Animator': 65,
  'Animation Team Lead': 80,
};

const CLIENTS = [
  {
    name: 'Lumen Interactive',
    project: {
      name: 'Orbit Rally', code: 'ORB',
      contractValue: 120000, invoicedToDate: 90000, billingType: 'fixed',
      /* Planned 1,090 hours, worked 1,010, billed all 1,010. Under the plan and
         fully invoiced — the shape a well-run fixed-bid project has. */
      team: [
        { name: 'Priya Sen',   level: 'Art Team Lead',        assigned: 120, actual: 110, billed: 110 },
        { name: 'Marc Oyelaran', level: 'Senior Artist',      assigned: 320, actual: 300, billed: 300 },
        { name: 'Hana Lund',   level: 'Mid Level Artist',     assigned: 280, actual: 260, billed: 260 },
        { name: 'Tobi Adeyemi', level: 'Junior Level Artist', assigned: 200, actual: 190, billed: 190 },
        { name: 'Ines Vidal',  level: 'Senior Animator',      assigned: 170, actual: 150, billed: 150 },
      ],
      otherCosts: [
        { label: 'Outsourced concept pass', amount: 4200 },
        { label: 'Reference photography licence', amount: 900 },
      ],
    },
  },
  {
    name: 'Aurora Games',
    project: {
      name: 'Nightgarden', code: 'NGD',
      contractValue: 95000, invoicedToDate: 95000, billingType: 'fixed',
      /* Planned 830, worked 1,065 — a 235-hour overrun concentrated on the
         expensive roles. Everything worked was billed, so the Actual tab reads
         normally; only the Fixed tab shows the damage. */
      team: [
        { name: 'Devi Raman',  level: 'Animation Team Lead',  assigned: 100, actual: 165, billed: 165 },
        { name: 'Kofi Mensah', level: 'Senior Animator',      assigned: 260, actual: 355, billed: 355 },
        { name: 'Lena Fischer', level: 'Mid Level Animator',  assigned: 240, actual: 290, billed: 290 },
        { name: 'Ravi Shetty', level: 'Senior Artist',        assigned: 150, actual: 175, billed: 175 },
        { name: 'Amara Boateng', level: 'Junior Level Animator', assigned: 80, actual: 80, billed: 80 },
      ],
      otherCosts: [
        { label: 'Motion capture stage hire', amount: 7600 },
      ],
    },
  },
  {
    name: 'Kestrel Studios',
    project: {
      name: 'Tidewater', code: 'TDW',
      contractValue: 70000, invoicedToDate: 41000, billingType: 'time_and_material',
      /* Planned 690 hours, worked 680 — comfortably inside the plan, so the
         Fixed tab shows nothing wrong. Only 545 of those hours were ever
         invoiced: 135 absorbed. The Actual tab is the only place that shows it,
         which is the entire argument for having two tabs. */
      team: [
        { name: 'Sofia Marchetti', level: 'Senior Artist',     assigned: 220, actual: 215, billed: 180 },
        { name: 'Ben Achterberg',  level: 'Mid Level Artist',  assigned: 190, actual: 195, billed: 150 },
        { name: 'Yuki Tanabe',     level: 'Mid Level Animator', assigned: 180, actual: 180, billed: 145 },
        { name: 'Omar Haddad',     level: 'Junior Level Artist', assigned: 100, actual: 90, billed: 70 },
      ],
      otherCosts: [
        { label: 'Freelance storyboard artist', amount: 3100 },
      ],
    },
  },
];

async function firstUserId() {
  const { rows } = await db.query('SELECT id FROM users ORDER BY created_at LIMIT 1');
  if (!rows.length) throw new Error('No users exist yet — bootstrap an account before seeding demo data.');
  return rows[0].id;
}

async function priceRateCards(log) {
  const cards = await pnl.rateCards(db);
  let priced = 0;
  for (const card of cards) {
    const rate = DEMO_RATES[card.level];
    /* Only where it is still zero. A studio that has set real rates keeps
       them — a demo script must not quietly re-price a live rate card. */
    if (rate && card.ratePerHour === 0) {
      await db.query('UPDATE rate_cards SET rate_per_hour = $1 WHERE id = $2', [rate, card.id]);
      priced += 1;
    }
  }
  log(`priced ${priced} rate card row${priced === 1 ? '' : 's'} that were still at zero`);
  return pnl.rateCards(db);
}

async function create(log) {
  const owner = await firstUserId();
  const cards = await priceRateCards(log);
  const cardFor = (level) => cards.find((c) => c.level === level);

  for (const spec of CLIENTS) {
    let { rows: existing } = await db.query('SELECT id FROM clients WHERE `name` = $1', [spec.name]);
    let clientId;
    if (existing.length) {
      clientId = existing[0].id;
      log(`client "${spec.name}" already exists — reusing it`);
    } else {
      clientId = uuid();
      await db.query(
        'INSERT INTO clients (id, `name`, notes, created_by) VALUES ($1,$2,$3,$4)',
        [clientId, spec.name, `${TAG} demonstration client`, owner]
      );
      log(`created client "${spec.name}"`);
    }

    const p = spec.project;
    const { rows: hadProject } = await db.query(
      'SELECT id FROM projects WHERE `name` = $1 AND client_id = $2', [p.name, clientId]);
    let projectId;
    if (hadProject.length) {
      projectId = hadProject[0].id;
      log(`  project "${p.name}" already exists — refreshing its P&L figures`);
      await db.query('DELETE FROM project_team_assignments WHERE project_id = $1', [projectId]);
      await db.query('DELETE FROM project_other_costs WHERE project_id = $1', [projectId]);
    } else {
      projectId = uuid();
      /* `projects` has no description column, so the tag lives on the CLIENT
         and a demo project is identified by belonging to a demo client. One
         marker, in one place, rather than two that could disagree. */
      await db.query(
        'INSERT INTO projects (id, client_id, `name`, code, owner_id) VALUES ($1,$2,$3,$4,$5)',
        [projectId, clientId, p.name, p.code, owner]
      );
      log(`  created project "${p.name}"`);
    }

    for (const member of p.team) {
      const card = cardFor(member.level);
      if (!card) { log(`  ! no rate card row for "${member.level}" — skipping ${member.name}`); continue; }
      await db.query(
        `INSERT INTO project_team_assignments
           (id, project_id, person_name, rate_card_id, \`role\`, level, rate_per_hour,
            assigned_hours, \`hours\`, billed_hours)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [uuid(), projectId, member.name, card.id, card.role, card.level, card.ratePerHour,
          member.assigned, member.actual, member.billed]
      );
    }
    for (const cost of p.otherCosts) {
      await db.query(
        'INSERT INTO project_other_costs (id, project_id, label, amount) VALUES ($1,$2,$3,$4)',
        [uuid(), projectId, cost.label, cost.amount]);
    }
    await db.query(
      `INSERT INTO project_billing (project_id, contract_value, billing_type, invoiced_to_date, updated_by)
       VALUES ($1,$2,$3,$4,$5)
       ON DUPLICATE KEY UPDATE contract_value = VALUES(contract_value),
         billing_type = VALUES(billing_type), invoiced_to_date = VALUES(invoiced_to_date)`,
      [projectId, p.contractValue, p.billingType, p.invoicedToDate, `${TAG}`]);

    // What this project will read as, so the run itself reports the shapes.
    const figures = await pnl.forProject(db, projectId, { cards });
    const t = figures.totals;
    log(`  ${p.name}: budget ${t.budgetedCost}, actual ${t.actualCost}, variance ${t.budgetVariance > 0 ? '+' : ''}${t.budgetVariance}`
      + `${t.overBudget ? '  << OVER BUDGET' : ''}`);
    log(`  ${' '.repeat(p.name.length)}  worked ${t.hoursTotal}h, billed ${t.billedHoursTotal}h`
      + `${t.hoursDelta > 0 ? `  << ${t.hoursDelta}h UNBILLED` : ''}`);
  }
}

async function remove(log) {
  /* Only what this script created, found by its tag. A demo cleaner that
     deleted by name would take a real client called Aurora Games with it. */
  const { rows } = await db.query(
    "SELECT id, `name` FROM clients WHERE notes LIKE $1", [`${TAG}%`]);
  if (!rows.length) { log('nothing tagged as demo data — nothing to remove'); return; }
  for (const client of rows) {
    /* Every project under a tagged client. The tag is on the client, so this is
       the whole set — and a client this script created cannot have acquired a
       real project without somebody having renamed the client first. */
    const { rows: projects } = await db.query(
      'SELECT id, `name` FROM projects WHERE client_id = $1', [client.id]);
    for (const project of projects) {
      for (const table of ['project_team_assignments', 'project_other_costs', 'pnl_snapshots']) {
        await db.query(`DELETE FROM ${table} WHERE project_id = $1`, [project.id]);
      }
      await db.query('DELETE FROM project_billing WHERE project_id = $1', [project.id]);
      await db.query('DELETE FROM projects WHERE id = $1', [project.id]);
      log(`removed project "${project.name}"`);
    }
    await db.query('DELETE FROM clients WHERE id = $1', [client.id]);
    log(`removed client "${client.name}"`);
  }
}

(async () => {
  const log = (m) => console.log(m);
  const removing = process.argv.includes('--remove');
  try {
    if (removing) await remove(log);
    else await create(log);
    log(removing ? 'Demo data removed.' : 'Demo data ready — open the Profit & Loss tab.');
    process.exit(0);
  } catch (err) {
    console.error('Failed:', err.message);
    process.exit(1);
  }
})();
