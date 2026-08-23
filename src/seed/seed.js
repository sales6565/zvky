require('dotenv').config();
const bcrypt = require('bcryptjs');
const { v4: uuid } = require('uuid');
const db = require('../db');
const { assignableRoles, leadRoles, roleDef } = require('../roles');
const referenceData = require('../reference-data');

const FIRST = ['Aiko','Ravi','Mika','Theo','Priya','Sam','Noor','Kai','Lena','Omar','Yuki','Diego','Alia','Finn','Sana','Wren','Dev','Zara','Milo','Ines','Kobe','Nell','Arjun','Talia','Bo'];
const LAST = ['Nakamura','Singh','Voss','Marchetti','Okafor','Reyes','Bergström','Haddad','Costa','Lindqvist','Park','Ferreira','Nazari','Holt','Achebe','Sorensen','Rao','Delgado','Kimura','Adeyemi','Novak','Petrov','Lund','Osei','Calder'];

let nameIdx = 0;
function nextName() {
  const f = FIRST[nameIdx % FIRST.length];
  const l = LAST[Math.floor(nameIdx / FIRST.length) % LAST.length];
  nameIdx++;
  return { name: `${f} ${l}`, email: `${f}.${l}${nameIdx}`.toLowerCase() + '@zvky.studio' };
}

const ASSET_SEED = [
  ['River Spirit — Hero', 'character', 'pending_tl_review', 'high', 'Main spirit design, needs flowing water FX integration on tail.', 18, 12],
  ['Cliffside Village', 'environment', 'pending_cd_review', 'med', 'Establishing wide shot environment for ep. 3 cold open.', 24, 8],
  ['Lantern Prop Set', 'prop', 'approved_for_client', 'low', 'Set of 6 hand-drawn lanterns, various sizes.', 6, 3],
  ['Rockslide FX', 'fx', 'not_started', 'high', 'Debris + dust particle pass for the canyon chase sequence.', 30, 21],
  ['Walk Cycle — Lead', 'animation', 'in_progress', 'med', '12-frame loop, needs cloth sim pass on cloak.', 15, 10],
  ['Dawn Sky Backdrop', 'background', 'delivered', 'low', 'Parallax-ready sky gradient, 3 layers.', 5, 1],
  ['Hero Turnaround', 'character', 'delivered', 'high', 'Full 360 model sheet, approved by art director.', 20, 2],
  ['Market Stalls', 'prop', 'in_progress', 'med', 'Modular stall pieces for village scenes.', 12, 14],
  ['Storm Cloud FX', 'fx', 'tl_changes_requested', 'med', 'Rolling storm buildup for act 2 climax.', 16, 9],
  ['Cavern Interior', 'environment', 'cd_changes_requested', 'low', 'Bioluminescent cave interior, mood lighting TBD.', 22, 16],
];
// Filled from the asset_types table once the reference data is in place.
let CODE_MAP = {};

// Spread the seeded staff across the studio's real designations rather than
// giving everyone the same one, so the Users tab shows the full catalogue in use.
function rotate(list, i) {
  return list[i % list.length];
}

async function main() {
  // Resolve the role lists once the reference tables are populated: the seed
  // spreads its staff across whatever designations the studio actually has.
  await require('../migrate').run(db, () => {});
  const LEADS = leadRoles();
  const CONTRIBUTORS = assignableRoles();
  CODE_MAP = Object.fromEntries(
    referenceData.list('asset_types', { includeInactive: true }).map((t) => [t.key, t.codePrefix])
  );

  const client = await db.connect();
  try {
    const { rows: existing } = await client.query('SELECT COUNT(*) AS n FROM users');
    const userCount = Number(existing[0].n);
    if (userCount > 0) {
      console.log(`Database already has ${userCount} users. Refusing to reseed. Drop the tables first if you want a clean slate.`);
      client.release();
      await db.end();
      process.exit(0);
    }

    await client.query('BEGIN');

    // A single reusable hash — same password, same hash, hashed once (bcrypt is
    // intentionally slow; hashing 500 identical passwords would take ~a minute).
    const demoHash = await bcrypt.hash('zvky2026', 10);
    const superHash = await bcrypt.hash('superadmin', 10);

    const superId = uuid();
    await client.query(
      'INSERT INTO users (id, `name`, email, password_hash, `role`) VALUES ($1,$2,$3,$4,\'super_admin\')',
      [superId, 'Ava Sterling', 'ava@zvky.studio', superHash]
    );

    const PROJECT_NAMES = ['Aurora Falls', 'Nightgarden', 'Comet Kids', 'Glass Harbor'];

    const cdIds = [];
    for (let i = 0; i < 3; i++) {
      const n = nextName();
      const id = uuid();
      cdIds.push(id);
      await client.query(
        'INSERT INTO users (id, `name`, email, password_hash, `role`, manager_id) VALUES ($1,$2,$3,$4,\'art_director\',$5)',
        [id, n.name, n.email, demoHash, superId]
      );
    }

    const adminIds = [];
    for (let i = 0; i < 15; i++) {
      const n = nextName();
      const id = uuid();
      adminIds.push(id);
      await client.query(
        'INSERT INTO users (id, `name`, email, password_hash, `role`, manager_id) VALUES ($1,$2,$3,$4,\'admin\',$5)',
        [id, n.name, n.email, demoHash, superId]
      );
    }

    const projects = [];
    for (let i = 0; i < PROJECT_NAMES.length; i++) {
      const id = uuid();
      const name = PROJECT_NAMES[i];
      const code = name.split(' ').map((w) => w[0]).join('').toUpperCase();
      const ownerId = adminIds[i % adminIds.length];
      await client.query('INSERT INTO projects (id, `name`, `code`, owner_id) VALUES ($1,$2,$3,$4)', [id, name, code, ownerId]);
      projects.push({ id, name, ownerId, teamLeadIds: [], artistIds: [] });
    }

    for (let i = 0; i < 40; i++) {
      const n = nextName();
      const id = uuid();
      const proj = projects[i % projects.length];
      await client.query(
        'INSERT INTO users (id, `name`, email, password_hash, `role`, manager_id) VALUES ($1,$2,$3,$4,$5,$6)',
        [id, n.name, n.email, demoHash, rotate(LEADS, i), proj.ownerId]
      );
      await client.query('INSERT INTO project_team_leads (project_id, user_id) VALUES ($1,$2)', [proj.id, id]);
      proj.teamLeadIds.push(id);
    }

    for (let i = 0; i < 44; i++) {
      const n = nextName();
      const id = uuid();
      const proj = projects[i % projects.length];
      await client.query(
        'INSERT INTO users (id, `name`, email, password_hash, `role`, manager_id) VALUES ($1,$2,$3,$4,\'coordinator\',$5)',
        [id, n.name, n.email, demoHash, proj.ownerId]
      );
      await client.query('INSERT INTO project_coordinators (project_id, user_id) VALUES ($1,$2)', [proj.id, id]);
    }

    const ARTIST_COUNT = 400;
    for (let i = 0; i < ARTIST_COUNT; i++) {
      const n = nextName();
      const id = uuid();
      const proj = projects[i % projects.length];
      const teamLeadId = proj.teamLeadIds[i % proj.teamLeadIds.length];
      await client.query(
        'INSERT INTO users (id, `name`, email, password_hash, `role`, manager_id, team_lead_id) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [id, n.name, n.email, demoHash, rotate(CONTRIBUTORS, i), proj.ownerId, teamLeadId]
      );
      proj.artistIds.push(id);
    }

    for (const proj of projects) {
      for (let i = 0; i < ASSET_SEED.length; i++) {
        const [name, type, status, priority, description, manHours, dueInDays] = ASSET_SEED[i];
        const assigneeId = proj.artistIds[i % proj.artistIds.length];
        const teamLeadId = proj.teamLeadIds[i % proj.teamLeadIds.length];
        const cdId = cdIds[i % cdIds.length];
        const assetId = uuid();
        const code = `${CODE_MAP[type]}-${String(i + 1).padStart(3, '0')}`;
        const dueDate = new Date(Date.now() + dueInDays * 86400000).toISOString().slice(0, 10);
        await client.query(
          'INSERT INTO assets (id, `code`, `name`, `type`, `status`, priority, project_id, assignee_id, description, man_hours, due_date) ' +
          'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
          [assetId, code, `${proj.name.split(' ')[0]} — ${name}`, type, status, priority, proj.id, assigneeId, description, manHours, dueDate]
        );
        const pastTl = ['pending_cd_review', 'cd_changes_requested', 'approved_for_client', 'delivered'].includes(status);
        const pastCd = ['approved_for_client', 'delivered'].includes(status);
        const defaultTasks = [
          ['Rough pass', true],
          ['Clean line', pastTl],
          ['Color / shade', pastCd],
        ];
        for (let t = 0; t < defaultTasks.length; t++) {
          await client.query(
            'INSERT INTO tasks (id, asset_id, `name`, done, `position`) VALUES ($1,$2,$3,$4,$5)',
            [uuid(), assetId, defaultTasks[t][0], defaultTasks[t][1] ? 1 : 0, t]
          );
        }

        // Give assets that are mid-review a believable version + feedback trail.
        const needsTlVersion = ['pending_tl_review', 'tl_changes_requested', 'pending_cd_review', 'cd_changes_requested', 'approved_for_client', 'delivered'].includes(status);
        if (needsTlVersion) {
          const v1 = uuid();
          await client.query(
            `INSERT INTO asset_versions (id, asset_id, version_number, stage, file_name, file_path, file_size, uploaded_by)
             VALUES ($1,$2,1,'tl',$3,$4,$5,$6)`,
            [v1, assetId, `${code.toLowerCase()}_v1.png`, 'placeholder', 482000, assigneeId]
          );
          if (status !== 'pending_tl_review') {
            const decision = status === 'tl_changes_requested' ? 'changes_requested' : 'approved';
            const note = decision === 'changes_requested' ? 'Silhouette reads a little flat from this angle — push the rim light and resubmit.' : 'Reads clean, nice work — approved to go up to the art director.';
            await client.query(
              'INSERT INTO feedback (id, asset_id, version_id, stage, decision, given_by, `text`) VALUES ($1,$2,$3,$4,$5,$6,$7)',
              [uuid(), assetId, v1, 'tl', decision, teamLeadId, note]
            );
          }
        }
        const needsCdVersion = ['pending_cd_review', 'cd_changes_requested', 'approved_for_client', 'delivered'].includes(status);
        if (needsCdVersion) {
          const v2 = uuid();
          await client.query(
            `INSERT INTO asset_versions (id, asset_id, version_number, stage, file_name, file_path, file_size, uploaded_by)
             VALUES ($1,$2,2,'cd',$3,$4,$5,$6)`,
            [v2, assetId, `${code.toLowerCase()}_v2.png`, 'placeholder', 510000, assigneeId]
          );
          if (status !== 'pending_cd_review') {
            const decision = status === 'cd_changes_requested' ? 'changes_requested' : 'approved';
            const note = decision === 'changes_requested' ? 'Color story is close, but the palette drifts warm against the rest of the sequence — cool it down half a stop and resubmit.' : 'Approved — ready to go to the client.';
            await client.query(
              'INSERT INTO feedback (id, asset_id, version_id, stage, decision, given_by, `text`) VALUES ($1,$2,$3,$4,$5,$6,$7)',
              [uuid(), assetId, v2, 'cd', decision, cdId, note]
            );
          }
        }
      }
    }

    await client.query('COMMIT');
    console.log('Seed complete:');
    console.log('  Super admin: ava@zvky.studio / superadmin');
    console.log('  Everyone else: <their email> / zvky2026');
    console.log(`  ${adminIds.length} admins, 40 leads across ${LEADS.length} supervisory designations,`);
    console.log(`  44 coordinators, ${ARTIST_COUNT} contributors across ${CONTRIBUTORS.length} designations,`);
    console.log(`  ${cdIds.length} art directors, ${projects.length} projects.`);
    console.log('  (Seeded review files are placeholders and are not downloadable — only real uploads are.)');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed:', err);
    process.exit(1);
  } finally {
    client.release();
    await db.end();
  }
}

main();
