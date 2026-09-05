/* The 62 permissions land on only thirteen distinct sets of designations. Naming
   those thirteen is what makes the role notes in the manual readable: "the
   administration band" instead of eight designations repeated on every page.
   The membership comes from roles-table.json, which is read out of a pristine
   instance — so a band is never hand-maintained, only named here. */
const data = require('./roles-table.json');

const NAMES = [
  ['everyone', 'Everyone',
    'Every designation in the studio, from Trainee upwards.'],
  ['asset_workers', 'Everyone who works on assets',
    'Everyone except the finance and administrative designations who never touch an asset.'],
  ['planners', 'Production planning',
    'Coordinators, project managers, producers, leads, supervisors and above — the people who put work into the pipeline.'],
  ['tl_gate', 'First review gate',
    'Everyone who may hold the Team Lead review: leads, supervisors, production and creative direction.'],
  ['leads', 'Leads and producers',
    'The people who run a queue: they carry lead notes and approve their team’s time sheets.'],
  ['supervisors', 'Anyone who supervises people',
    'Anyone with a team under them, which is what the My Team tab lists.'],
  ['delivery', 'Delivery',
    'Production and account management — the people who hand finished work to a client.'],
  ['cd_gate', 'Creative direction',
    'The Creative Director gate: art direction and above.'],
  ['administration', 'Administration',
    'The people who run the studio’s records: staff, projects and clients.'],
  ['leadership', 'Studio leadership',
    'Administration without the Admin designation — the settings, reports and overrides tier.'],
  ['runs_work', 'Production planning and creative direction',
    'The production planning band with Art Director and Creative Art Director added — everyone who runs work rather than doing it. Who may start a chat group.'],
  ['cd_and_super', 'Creative Art Director and Super Admin',
    'A deliberately narrow pair: the project-review queue.'],
  ['super_only', 'Super Admin only',
    'Nobody else holds this out of the box.'],
];

// Every distinct set of holders, keyed by its membership.
const sets = new Map();
for (const g of data.groups) for (const p of g.permissions) {
  const k = p.roles.join(' ');
  if (!sets.has(k)) sets.set(k, { roles: p.roles, permissions: [] });
  sets.get(k).permissions.push(p.key);
}
const ordered = [...sets.values()];

/* Naming is by what the set CONTAINS, not by its size - two bands can be the
   same size and mean different things. Each name above is matched to the set
   holding the permission that most plainly defines it. */
const SEED = {
  everyone: 'timesheet.own',
  asset_workers: 'asset.edit',
  planners: 'asset.add',
  tl_gate: 'review.tl',
  leads: 'asset.lead_notes',
  supervisors: 'user.view_team',
  delivery: 'review.deliver',
  cd_gate: 'review.cd',
  administration: 'user.view',
  leadership: 'user.idle_view',
  runs_work: 'chat.group_create',
  cd_and_super: 'project.review_queue',
  super_only: 'review.client_view',
};
const band = {};
for (const [key, label, note] of NAMES) {
  const hit = ordered.find((s) => s.permissions.includes(SEED[key]));
  if (!hit) throw new Error(`no permission set contains ${SEED[key]} - the bands are out of date`);
  band[key] = { key, label, note, roles: hit.roles, permissions: hit.permissions };
}
if (Object.keys(band).length !== ordered.length) {
  throw new Error(`${ordered.length} distinct permission sets but ${Object.keys(band).length} named bands`);
}
// Which band a permission falls in, for the appendix.
const bandOf = {};
for (const b of Object.values(band)) for (const p of b.permissions) bandOf[p] = b;

module.exports = { band, bandOf, groups: data.groups, roles: data.roles, count: ordered.length };
