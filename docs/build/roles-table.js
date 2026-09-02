/* The role-access tables in the manual, generated from the code that actually
   decides them — src/permission-catalog.js and defaultsFor() — rather than
   written by hand and left to drift. */
const catalog = require('/home/user/zvky/src/permission-catalog');
const fs = require('fs');
const { execFileSync } = require('child_process');

/* Read from a PRISTINE instance (zvky_defaults: schema loaded, booted once,
   nothing else done to it), because the manual documents what a deployment
   ships with. The demo instance the screenshots come from has had three roles
   edited to stage the review flow, and those edits are not the product's
   defaults. Every table this writes is therefore "out of the box", and the
   manual says so beside them — a Super Admin may change any of it. */
/* Point this at whichever deployment should be described. The default is a
   pristine one, so the manual documents what the software ships with; set
   DOCS_DB (and DOCS_DB_USER) to describe a studio's own configuration. */
const DB = process.env.DOCS_DB || 'zvky_defaults';
const DB_USER = process.env.DOCS_DB_USER || 'root';
const q = (sql) => execFileSync('mysql', ['-u', DB_USER, DB, '-N','-B','-e',sql], { encoding:'utf8' })
  .trim().split('\n').filter(Boolean).map(l => l.split('\t'));

const roles = q("SELECT `key`, label, tier, group_name FROM roles WHERE is_active = 1 ORDER BY position, label")
  .map(([key,label,tier,dept]) => ({ key, label, tier, dept }));
const held = new Map(roles.map(r => [r.key, new Set()]));
for (const [role, perm] of q('SELECT role_key, permission_key FROM role_permissions WHERE enabled = 1'))
  if (held.has(role)) held.get(role).add(perm);

const out = { groups: [], roles };

for (const g of catalog.GROUPS || catalog.groups || []) {
  const grp = { key: g.key, label: g.label, permissions: [] };
  for (const p of g.permissions) {
    const who = roles.filter(r => held.get(r.key).has(p.key)).map(r => r.label);
    grp.permissions.push({ key: p.key, label: p.label, describe: p.describe || '', roles: who });
  }
  out.groups.push(grp);
}
fs.writeFileSync(__dirname + '/roles-table.json', JSON.stringify(out, null, 1));
console.log('roles:', roles.length, 'groups:', out.groups.length,
  'permissions:', out.groups.reduce((n,g)=>n+g.permissions.length,0));
for (const g of out.groups) for (const p of g.permissions)
  console.log(String(p.roles.length).padStart(3), p.key, '-', p.roles.length > 8 ? p.roles.slice(0,4).join(', ') + ' …' : p.roles.join(', ') || '(nobody)');
