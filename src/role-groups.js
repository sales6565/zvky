/* ROLE GROUPS: an ADDITIVE layer over role permissions, and nothing else.
 *
 * A group is a named bag of permissions with a list of member roles. A role's
 * effective permissions are its own plus the grants of every group it is in.
 * That is the whole feature, and the three things it deliberately is NOT are
 * worth stating because each one would change the existing model:
 *
 *   NO GROUP-LEVEL DENY. Groups only ever add. A permission a group does not
 *      grant is a permission the group has no opinion about.
 *   NO NESTING. A group contains roles, never other groups. One hop, so the
 *      answer is a single join and cannot cycle.
 *   NO CAPABILITIES. Groups grant catalogue keys. projectScope, reviewStage and
 *      deleteAsset are values rather than booleans and stay with the tier — see
 *      the note at the top of src/role-permissions.js.
 *
 * ---------------------------------------------------------------------------
 * HOW AN EXPLICIT ROLE-LEVEL "OFF" INTERACTS WITH A GROUP GRANT, and why.
 *
 * In this application "off" is a ROW, not an absence: role_permissions holds one
 * row per (role, permission) with enabled 0 or 1, and setForRole() writes all
 * ninety-six keys on every save. So after a Super Admin has saved a role once,
 * every permission that role does not hold carries an explicit enabled = 0 row
 * with that admin's email on it — including the ninety keys they never looked
 * at. The column therefore CANNOT distinguish "deliberately revoked" from
 * "never granted"; only updated_by_email hints at it, and one save stamps the
 * same email on every row.
 *
 * THE DECISION: a group grant is additive and is not blocked by enabled = 0.
 * A group can re-grant something an administrator unticked on the role.
 *
 * THE CONSEQUENCE, STATED RATHER THAN HIDDEN: that is a real behaviour an
 * administrator can be surprised by, so it is made visible rather than silent —
 * the role's permission view marks every inherited key with the group it comes
 * from, deleting a group lists what will be lost before confirming, and every
 * change is audited. The alternative — "role-level off wins" — needs a third
 * state in role_permissions (granted / silent / revoked) to be expressible at
 * all, which is a change to the existing storage and to what a save means, and
 * the brief's hard constraint is that existing role permissions do not change.
 *
 * ---------------------------------------------------------------------------
 * ONE QUERY PER REQUEST, and it does not grow.
 *
 * effectiveFor() runs on every authenticated request. Group grants are fetched
 * with a single join keyed on role_key — not one query per group and not one
 * per permission — so a studio with forty groups costs exactly what a studio
 * with one costs.
 */
const { v4: uuid } = require('uuid');
const catalog = require('./permission-catalog');
const { roleDef } = require('./roles');

/* WHAT A GROUP IS FOR, as a fixed vocabulary.
 *
 * Three kinds because the studio named three ways it thinks about roles — by
 * department, by seniority, and "a set we made up for this" — and a free-text
 * field would have become all three plus typos. Validated against this list, so
 * a kind the screen does not offer cannot arrive through the API. */
const KINDS = ['department', 'level', 'custom'];
const KIND_LABELS = { department: 'Department', level: 'Level', custom: 'Custom' };

const NAME_MAX = 80;
const DESCRIPTION_MAX = 300;

/* THE TWO KEYS A GROUP MAY NEVER GRANT, and they are the two that would let a
 * group hand out the power to make more groups.
 *
 *   settings.permissions  the role-permission screen itself. The catalogue
 *                         already marks it grantable: false and setForRole
 *                         strips it from any role but Super Admin's; a group
 *                         granting it would be the same door left open one
 *                         level up.
 *   settings.role_groups  this screen. A group that could grant it could add
 *                         its own members to a group that grants everything.
 *
 * Checked on the write, not only on the screen. */
const NEVER_GRANTABLE = ['settings.permissions', 'settings.role_groups'];

const MANAGE_KEY = 'settings.role_groups';

function grantable(key) {
  return catalog.isPermission(key) && !NEVER_GRANTABLE.includes(key);
}

/* ---------- reading ---------------------------------------------------------- */

/* THE ONE QUERY. Every group grant that reaches this role, in one hop.
 *
 * Returns a Set of permission keys. An empty Set for a role in no group, which
 * is what makes the no-groups case identical to the behaviour before this
 * existed — asserted against a snapshot of every role taken before the feature
 * was written (tests/fixtures/role-permissions-before-groups.json).
 *
 * UNKNOWN KEYS ARE DROPPED ON READ as well as refused on write: the catalogue
 * can shrink, and a key that is no longer a permission must not travel as one.
 */
async function grantsForRole(db, roleKey) {
  if (!roleKey) return new Set();
  const { rows } = await db.query(
    `SELECT DISTINCT gp.permission_key
       FROM role_group_members gm
       JOIN role_group_permissions gp ON gp.group_id = gm.group_id
      WHERE gm.role_key = $1`,
    [roleKey]
  );
  return new Set(rows.map((r) => r.permission_key).filter((k) => catalog.isPermission(k)));
}

/* THE SAME QUESTION FOR ONE PERSON: every grant that reaches them through a
 * group they were added to DIRECTLY — Prompt 73.
 *
 * A sibling of grantsForRole() rather than a replacement for it. The two answer
 * different questions and effectiveFor() unions both, so neither is a second
 * resolution path: there is one union, in one function, fed by two reads.
 *
 * INACTIVE ACCOUNTS GET NOTHING, and the join is where that is decided rather
 * than in a caller. A deactivated account cannot sign in at all, so for the
 * request path this is belt and braces — but effectiveFor() is also asked
 * ABOUT other people (the password-reset guard, hold-explain, the diagnostic),
 * and those must not be told that a deactivated account still holds a group's
 * keys. The row stays; the grant stops. Reactivating gives it back with no
 * membership to restore by hand, which is the same thing that happens to a
 * role when an account comes back.
 *
 * ONE QUERY, keyed on user_id, exactly like its sibling: a studio with forty
 * groups costs what a studio with one costs.
 */
async function grantsForUser(db, userId) {
  if (!userId) return new Set();
  const { rows } = await db.query(
    `SELECT DISTINCT gp.permission_key
       FROM role_group_users gu
       JOIN users u ON u.id = gu.user_id AND u.is_active = 1
       JOIN role_group_permissions gp ON gp.group_id = gu.group_id
      WHERE gu.user_id = $1`,
    [userId]
  );
  return new Set(rows.map((r) => r.permission_key).filter((k) => catalog.isPermission(k)));
}

/* WHICH GROUPS THIS PERSON IS IN DIRECTLY, by name — for the user detail panel
 * and for the diagnostic, both of which report rather than decide.
 *
 * NOT FILTERED BY is_active. "Also in groups: Release Managers" is a true
 * statement about a deactivated account and the thing an administrator needs to
 * see before reactivating it; whether it GRANTS anything is grantsForUser()'s
 * question, asked above and answered no. A panel that hid the membership would
 * make a reactivated account's permissions arrive from nowhere.
 */
async function groupsForUser(db, userId) {
  if (!userId) return [];
  const { rows } = await db.query(
    `SELECT g.id, g.name, g.kind
       FROM role_group_users gu
       JOIN role_groups g ON g.id = gu.group_id
      WHERE gu.user_id = $1
      ORDER BY g.name`,
    [userId]
  );
  return rows.map((r) => ({ id: r.id, name: r.name, kind: r.kind }));
}

/* The same answer, but saying WHICH group each grant came from — for the role's
   permission view, which has to show inheritance rather than just the union. */
async function inheritanceForRole(db, roleKey) {
  if (!roleKey) return [];
  const { rows } = await db.query(
    `SELECT g.id, g.name, g.kind, gp.permission_key
       FROM role_group_members gm
       JOIN role_groups g ON g.id = gm.group_id
       LEFT JOIN role_group_permissions gp ON gp.group_id = g.id
      WHERE gm.role_key = $1
      ORDER BY g.name, gp.permission_key`,
    [roleKey]
  );
  const byGroup = new Map();
  for (const row of rows) {
    if (!byGroup.has(row.id)) {
      byGroup.set(row.id, { id: row.id, name: row.name, kind: row.kind, permissions: [] });
    }
    if (row.permission_key && catalog.isPermission(row.permission_key)) {
      byGroup.get(row.id).permissions.push(row.permission_key);
    }
  }
  return [...byGroup.values()];
}

/* Every group, with its members and grants, for the screen. Three queries for
   the whole screen rather than three per group. */
async function list(db) {
  const { rows: groups } = await db.query(
    'SELECT id, name, kind, description, created_at, updated_at FROM role_groups ORDER BY kind, name'
  );
  if (!groups.length) return [];
  const { rows: members } = await db.query('SELECT group_id, role_key FROM role_group_members');
  const { rows: grants } = await db.query('SELECT group_id, permission_key FROM role_group_permissions');
  /* THE DIRECT MEMBERS, in the screen's one extra query rather than one per
     group — the same shape as the two reads above it.
     
     EACH ONE CARRIES THEIR ROLE, because the editor's question is not only "who
     is in this group" but "who is in it twice over": somebody whose role is
     ALSO in the group gains nothing from the direct row, and the screen marks
     them so the owner can see that rather than working it out. Deciding it
     here, where both lists are in hand, keeps the page from computing it. */
  const { rows: directs } = await db.query(
    `SELECT gu.group_id, u.id, u.\`name\`, u.email, u.\`role\`, u.is_active
       FROM role_group_users gu
       JOIN users u ON u.id = gu.user_id
      ORDER BY u.\`name\``
  );

  const byId = new Map(groups.map((g) => [g.id, {
    ...g,
    kindLabel: KIND_LABELS[g.kind] || g.kind,
    roles: [],
    users: [],
    permissions: [],
  }]));
  for (const m of members) {
    const g = byId.get(m.group_id);
    if (!g) continue;
    const def = roleDef(m.role_key);
    g.roles.push({ key: m.role_key, label: def ? def.label : m.role_key, known: Boolean(def) });
  }
  for (const p of grants) {
    const g = byId.get(p.group_id);
    if (!g || !catalog.isPermission(p.permission_key)) continue;
    g.permissions.push(p.permission_key);
  }
  for (const d of directs) {
    const g = byId.get(d.group_id);
    if (!g) continue;
    const def = roleDef(d.role);
    g.users.push({
      id: d.id,
      name: d.name,
      email: d.email,
      role: d.role,
      roleLabel: def ? def.label : d.role,
      isActive: d.is_active !== 0,
      /* Filled in below, once this group's role list is known. */
      viaRole: false,
    });
  }
  for (const g of byId.values()) {
    g.roles.sort((a, b) => a.label.localeCompare(b.label));
    g.permissions.sort();
    const roleKeys = new Set(g.roles.map((r) => r.key));
    for (const u of g.users) u.viaRole = roleKeys.has(u.role);
    g.users.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  }
  return [...byId.values()];
}

async function get(db, id) {
  const all = await list(db);
  return all.find((g) => g.id === id) || null;
}

/* WHAT DELETING THIS GROUP WOULD COST, asked before anybody confirms.
 *
 * Not "n roles and m permissions" — which roles, and which permissions each one
 * would actually LOSE. A role that holds a permission in its own right loses
 * nothing when the group goes, and saying otherwise would make the warning
 * noise rather than information. The caller passes the own-permission lookup so
 * this module does not have to know how a role's own set is built. */
async function impactOfDeleting(db, id, ownFor) {
  const group = await get(db, id);
  if (!group) return null;
  const losses = [];
  for (const role of group.roles) {
    /* Everything this role would still have: its own set, plus every OTHER
       group it is in. Only what is left over is a real loss. */
    const own = await ownFor(role.key);
    const otherGroups = (await inheritanceForRole(db, role.key))
      .filter((g) => g.id !== id)
      .flatMap((g) => g.permissions);
    const keeps = new Set([...own, ...otherGroups]);
    const lost = group.permissions.filter((k) => !keeps.has(k));
    if (lost.length) losses.push({ role: role.key, label: role.label, lost });
  }
  return { group, losses };
}

/* ---------- writing --------------------------------------------------------- */

function validateName(name) {
  const trimmed = String(name === undefined || name === null ? '' : name).trim();
  if (!trimmed) return { ok: false, status: 400, field: 'name', error: 'Give the group a name.' };
  if (trimmed.length > NAME_MAX) {
    return { ok: false, status: 400, field: 'name',
      error: `That name is longer than ${NAME_MAX} characters.` };
  }
  return { ok: true, name: trimmed };
}

function validateKind(kind) {
  const value = String(kind || '').trim().toLowerCase();
  if (!KINDS.includes(value)) {
    return { ok: false, status: 400, field: 'kind',
      error: `A group is a ${KINDS.join(', a ')} — not "${kind}".` };
  }
  return { ok: true, kind: value };
}

/* THE PERMISSIONS A GROUP MAY BE GIVEN, judged against the catalogue AND against
 * the person doing the giving.
 *
 * THREE RULES, and the second is the escalation one:
 *
 *   1. it has to be a permission        unknown keys are refused by name rather
 *                                       than dropped, so a typo is visible
 *   2. the editor has to hold it        nobody grants through a group what they
 *                                       could not grant directly. Read off
 *                                       req.permissions, which the server
 *                                       resolved for this session
 *   3. never the two bootstrap keys     NEVER_GRANTABLE above
 *
 * Duplicates collapse rather than erroring: sending a key twice is a request
 * for it to be granted, which it is. */
function validatePermissions(keys, editorHolds) {
  if (!Array.isArray(keys)) {
    return { ok: false, status: 400, field: 'permissions',
      error: 'Send the permissions this group should grant.' };
  }
  const unknown = [...new Set(keys.filter((k) => !catalog.isPermission(k)))];
  if (unknown.length) {
    return { ok: false, status: 400, field: 'permissions',
      error: `Not a permission: ${unknown.join(', ')}` };
  }
  const forbidden = [...new Set(keys.filter((k) => NEVER_GRANTABLE.includes(k)))];
  if (forbidden.length) {
    return { ok: false, status: 400, field: 'permissions',
      error: `A group cannot grant ${forbidden.map((k) => label(k)).join(' or ')}. `
        + 'Those are the keys that decide who may hand out permissions, so they are granted '
        + 'per role by a Super Admin and never inherited.' };
  }
  const beyond = [...new Set(keys.filter((k) => !editorHolds.has(k)))];
  if (beyond.length) {
    return { ok: false, status: 403, field: 'permissions',
      error: `You cannot grant ${beyond.map((k) => label(k)).join(', ')} through a group, `
        + 'because you do not hold it yourself.' };
  }
  return { ok: true, permissions: [...new Set(keys)] };
}

const label = (key) => (catalog.BY_KEY.get(key) || {}).label || key;

/* THE ROLES A GROUP MAY CONTAIN.
 *
 * Unknown role keys are refused. Super Admin is allowed in — it changes nothing,
 * because effectiveFor() short-circuits that tier to the whole catalogue before
 * any of this is consulted, so a group can neither add to nor take from it.
 * Refusing it would be a rule with no effect to explain. */
function validateRoles(keys) {
  if (!Array.isArray(keys)) {
    return { ok: false, status: 400, field: 'roles', error: 'Send the roles in this group.' };
  }
  const unknown = [...new Set(keys.filter((k) => !roleDef(k)))];
  if (unknown.length) {
    return { ok: false, status: 400, field: 'roles',
      error: `Not a role: ${unknown.join(', ')}` };
  }
  return { ok: true, roles: [...new Set(keys)] };
}

/* THE USERS A GROUP MAY CONTAIN — Prompt 73.
 *
 * Shaped like validateRoles(): unknown ids are refused BY NAME rather than
 * dropped, because a group that silently ignored half of what somebody sent is
 * a group whose membership nobody can trust. The two differences from roles are
 * the ones a role cannot have:
 *
 *   ONLY ACTIVE ACCOUNTS MAY BE ADDED. A deactivated account gets nothing from
 *     a group (see grantsForUser), so adding one would be a row that does
 *     nothing while reading as though it did something. Refused with the reason
 *     and the names.
 *   NO SELF-ADDING RULE, and that is deliberate rather than an omission. The
 *     escalation guard below already says nobody hands out a key they do not
 *     hold, which is what adding yourself to a powerful group would be. A
 *     separate self-check would only refuse an administrator adding themselves
 *     to a group of keys they already hold, which is harmless and useful.
 *
 * Needs the database, unlike its sibling: "is this a real, active account" is a
 * row, where a designation is reference data already in memory.
 */
async function validateUsers(db, ids) {
  if (!Array.isArray(ids)) {
    return { ok: false, status: 400, field: 'users', error: 'Send the users in this group.' };
  }
  const wanted = [...new Set(ids.map((id) => String(id || '')).filter(Boolean))];
  if (!wanted.length) return { ok: true, users: [] };

  const holes = wanted.map((_, i) => `$${i + 1}`).join(',');
  const { rows } = await db.query(
    `SELECT id, \`name\`, is_active FROM users WHERE id IN (${holes})`, wanted);
  const found = new Map(rows.map((r) => [r.id, r]));

  const missing = wanted.filter((id) => !found.has(id));
  if (missing.length) {
    return { ok: false, status: 400, field: 'users',
      error: missing.length === 1
        ? 'That account does not exist.'
        : `${missing.length} of those accounts do not exist.` };
  }
  const inactive = wanted.filter((id) => found.get(id).is_active === 0);
  if (inactive.length) {
    return { ok: false, status: 400, field: 'users',
      error: `${inactive.map((id) => found.get(id).name).join(', ')} `
        + `${inactive.length === 1 ? 'is a deactivated account' : 'are deactivated accounts'}, `
        + 'so a group would grant them nothing. Reactivate the account first.' };
  }
  return { ok: true, users: wanted };
}

/* THE ESCALATION GUARD FOR HANDING A GROUP TO SOMEBODY — a person, and from
 * Prompt 73 a role as well.
 *
 * ===========================================================================
 * WHAT THE RULE WAS, AND WHY THIS IS WHERE IT NOW LIVES.
 *
 * Until now the escalation rule was entirely on the PERMISSIONS side:
 * validatePermissions() refuses a key the editor does not hold, so a group
 * cannot be BUILT out of permissions its author lacks. Attaching a role was
 * checked for nothing beyond holding settings.role_groups.
 *
 * That left a door open. A group's keys were vetted against whoever put them
 * there — never against whoever later attaches a role to it. So an editor with
 * the group screen and nothing else could take a group granting asset.delete,
 * attach a designation, and hand out a permission they could not have granted
 * directly on the role screen.
 *
 * The brief asks that adding a USER carry "the same escalation guard as for
 * attaching a role". The only way to make the two the same is one function used
 * by both, and the only reading of it that is actually a guard is the strict
 * one. So: handing a group's grants to anybody requires holding every one of
 * them. The message names the keys, so the refusal says what to do about it.
 *
 * A GROUP THAT GRANTS NOTHING is open to any editor, and that is not a hole:
 * there is nothing to hand out, and keys cannot be added to it later without
 * passing validatePermissions() against whoever adds them.
 */
function mayHandOut(group, editorHolds) {
  const holds = editorHolds || new Set();
  const beyond = group.permissions.filter((k) => !holds.has(k));
  if (!beyond.length) return { ok: true };
  return {
    ok: false, status: 403, field: 'permissions',
    error: `"${group.name}" grants ${beyond.map((k) => label(k)).join(', ')}, which you do not `
      + 'hold yourself — so you cannot give this group to anybody. Ask somebody who holds it.',
  };
}

async function record(db, { groupId, groupName, action, detail, actor }) {
  await db.query(
    `INSERT INTO role_group_audit (id, group_id, group_name, action, detail, actor_id, actor_email)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [uuid(), groupId || null, groupName || null, action, detail || null,
      actor ? actor.id : null, actor ? actor.email : null]
  );
  console.log(`[role-groups] ${actor ? actor.email : 'system'} ${action} "${groupName}"`
    + `${detail ? ` — ${detail}` : ''}`);
}

async function create(db, { name, kind, description }, actor) {
  const named = validateName(name);
  if (!named.ok) return named;
  const kinded = validateKind(kind);
  if (!kinded.ok) return kinded;

  const { rows: clash } = await db.query('SELECT id FROM role_groups WHERE name = $1', [named.name]);
  if (clash.length) {
    return { ok: false, status: 409, field: 'name', error: `There is already a group called "${named.name}".` };
  }
  const id = uuid();
  await db.query(
    'INSERT INTO role_groups (id, name, kind, description, created_by_email) VALUES ($1,$2,$3,$4,$5)',
    [id, named.name, kinded.kind, String(description || '').trim().slice(0, DESCRIPTION_MAX) || null,
      actor ? actor.email : null]
  );
  await record(db, { groupId: id, groupName: named.name, action: 'created',
    detail: KIND_LABELS[kinded.kind], actor });
  return { ok: true, group: await get(db, id) };
}

async function rename(db, id, { name, kind, description }, actor) {
  const before = await get(db, id);
  if (!before) return { ok: false, status: 404, error: 'That group does not exist.' };

  const patch = {};
  if (name !== undefined) {
    const named = validateName(name);
    if (!named.ok) return named;
    if (named.name !== before.name) {
      const { rows: clash } = await db.query(
        'SELECT id FROM role_groups WHERE name = $1 AND id <> $2', [named.name, id]);
      if (clash.length) {
        return { ok: false, status: 409, field: 'name',
          error: `There is already a group called "${named.name}".` };
      }
    }
    patch.name = named.name;
  }
  if (kind !== undefined) {
    const kinded = validateKind(kind);
    if (!kinded.ok) return kinded;
    patch.kind = kinded.kind;
  }
  if (description !== undefined) {
    patch.description = String(description || '').trim().slice(0, DESCRIPTION_MAX) || null;
  }
  if (!Object.keys(patch).length) return { ok: true, group: before, unchanged: true };

  await db.query(
    'UPDATE role_groups SET name = COALESCE($1, name), kind = COALESCE($2, kind), '
    + 'description = CASE WHEN $3 = 1 THEN $4 ELSE description END WHERE id = $5',
    [patch.name === undefined ? null : patch.name,
      patch.kind === undefined ? null : patch.kind,
      'description' in patch ? 1 : 0,
      patch.description === undefined ? null : patch.description,
      id]
  );
  const detail = Object.entries(patch)
    .map(([k, v]) => `${k}: ${before[k] === v ? 'unchanged' : `"${before[k] || ''}" → "${v || ''}"`}`)
    .join(', ');
  await record(db, { groupId: id, groupName: patch.name || before.name, action: 'renamed', detail, actor });
  return { ok: true, group: await get(db, id) };
}

async function remove(db, id, actor) {
  const before = await get(db, id);
  if (!before) return { ok: false, status: 404, error: 'That group does not exist.' };
  /* The members and the grants go with it, by the foreign keys — see the
     migration. Deleting the parent row is the whole delete, which is what makes
     "no orphan rows" a property of the schema rather than of this function
     remembering. */
  await db.query('DELETE FROM role_groups WHERE id = $1', [id]);
  await record(db, { groupId: null, groupName: before.name, action: 'deleted',
    detail: `${before.roles.length} role(s), ${before.permissions.length} permission(s)`, actor });
  return { ok: true, deleted: before };
}

async function setRoles(db, id, roleKeys, actor, editorHolds) {
  const group = await get(db, id);
  if (!group) return { ok: false, status: 404, error: 'That group does not exist.' };
  const checked = validateRoles(roleKeys);
  if (!checked.ok) return checked;
  /* HANDING THIS GROUP TO A DESIGNATION IS HANDING OUT ITS KEYS — see
     mayHandOut(). The same call guards setUsers() below, which is what makes
     "the rule for a user is the rule for a role" true of the code rather than
     of two paragraphs that agree today. */
  const allowed = mayHandOut(group, editorHolds);
  if (!allowed.ok) return allowed;

  const had = new Set(group.roles.map((r) => r.key));
  const wanted = new Set(checked.roles);
  const added = [...wanted].filter((k) => !had.has(k));
  const removed = [...had].filter((k) => !wanted.has(k));

  for (const key of removed) {
    await db.query('DELETE FROM role_group_members WHERE group_id = $1 AND role_key = $2', [id, key]);
  }
  for (const key of added) {
    await db.query(
      'INSERT IGNORE INTO role_group_members (group_id, role_key, added_by_email) VALUES ($1,$2,$3)',
      [id, key, actor ? actor.email : null]
    );
  }
  if (added.length || removed.length) {
    await record(db, { groupId: id, groupName: group.name, action: 'members',
      detail: [added.length ? `+${added.join(', ')}` : '', removed.length ? `-${removed.join(', ')}` : '']
        .filter(Boolean).join(' '),
      actor });
  }
  return { ok: true, group: await get(db, id), added, removed };
}

/* THE DIRECT MEMBERS OF A GROUP, SET IN ONE CALL — Prompt 73.
 *
 * The same shape as setRoles(): the editor sends the list they want, this works
 * out the difference, and only the difference is written and audited. A list
 * identical to what is stored is a no-op that records nothing, which is what
 * makes saving the editor twice harmless and makes "adding somebody already in
 * the group is idempotent" fall out rather than being special-cased.
 *
 * INSERT IGNORE against the primary key is the other half of that: two requests
 * racing to add the same person end with one row and no error.
 *
 * WHAT IT RETURNS: the ids added and removed, because the caller has to audit
 * them, notify the people added, and say how many of each in the response. It
 * returns ids rather than names — the caller already has the group with every
 * member's name on it.
 */
async function setUsers(db, id, userIds, actor, editorHolds) {
  const group = await get(db, id);
  if (!group) return { ok: false, status: 404, error: 'That group does not exist.' };
  const checked = await validateUsers(db, userIds);
  if (!checked.ok) return checked;
  const allowed = mayHandOut(group, editorHolds);
  if (!allowed.ok) return allowed;

  const had = new Set(group.users.map((u) => u.id));
  const wanted = new Set(checked.users);
  const added = [...wanted].filter((uid) => !had.has(uid));
  const removed = [...had].filter((uid) => !wanted.has(uid));

  for (const uid of removed) {
    await db.query('DELETE FROM role_group_users WHERE group_id = $1 AND user_id = $2', [id, uid]);
  }
  for (const uid of added) {
    await db.query(
      'INSERT IGNORE INTO role_group_users (group_id, user_id, added_by_email) VALUES ($1,$2,$3)',
      [id, uid, actor ? actor.email : null]
    );
  }
  const after = await get(db, id);
  if (added.length || removed.length) {
    /* THE AUDIT LINE NAMES PEOPLE, not ids: this row is read by a human
       months later, and a uuid tells them nothing. The names come from the
       group as it is now for anybody added, and from the group as it WAS for
       anybody removed — who is, by definition, no longer in the new one. */
    const nameOf = (uid) => (after.users.find((u) => u.id === uid)
      || group.users.find((u) => u.id === uid) || {}).name || uid;
    await record(db, { groupId: id, groupName: group.name, action: 'users',
      detail: [added.length ? `+${added.map(nameOf).join(', ')}` : '',
        removed.length ? `-${removed.map(nameOf).join(', ')}` : '']
        .filter(Boolean).join(' '),
      actor });
  }
  return { ok: true, group: after, added, removed };
}

async function setPermissions(db, id, keys, actor, editorHolds) {
  const group = await get(db, id);
  if (!group) return { ok: false, status: 404, error: 'That group does not exist.' };
  const checked = validatePermissions(keys, editorHolds || new Set());
  if (!checked.ok) return checked;

  const had = new Set(group.permissions);
  const wanted = new Set(checked.permissions);
  const added = [...wanted].filter((k) => !had.has(k));
  const removed = [...had].filter((k) => !wanted.has(k));

  for (const key of removed) {
    await db.query('DELETE FROM role_group_permissions WHERE group_id = $1 AND permission_key = $2',
      [id, key]);
  }
  for (const key of added) {
    await db.query(
      'INSERT IGNORE INTO role_group_permissions (group_id, permission_key, added_by_email) VALUES ($1,$2,$3)',
      [id, key, actor ? actor.email : null]
    );
  }
  if (added.length || removed.length) {
    await record(db, { groupId: id, groupName: group.name, action: 'permissions',
      detail: [added.length ? `+${added.join(', ')}` : '', removed.length ? `-${removed.join(', ')}` : '']
        .filter(Boolean).join(' '),
      actor });
  }
  return { ok: true, group: await get(db, id), added, removed };
}

/* A DESIGNATION WAS DELETED: forget it everywhere.
 *
 * Called by the reference-data delete path. There is no foreign key to roles —
 * role_permissions has never had one either, because a designation lives in
 * reference data that loads into memory — so this is the cleanup, and the
 * migration sweeps anything an older install left behind. */
async function forgetRole(db, roleKey) {
  if (!roleKey) return 0;
  const { result } = await db.query('DELETE FROM role_group_members WHERE role_key = $1', [roleKey]);
  return (result && result.affectedRows) || 0;
}

async function audit(db, limit = 100) {
  const capped = Math.min(Number(limit) || 100, 500);
  const { rows } = await db.query(
    'SELECT * FROM role_group_audit ORDER BY seq DESC LIMIT $1', [capped]);
  return rows.map((r) => ({
    id: r.id,
    group: r.group_name,
    action: r.action,
    detail: r.detail,
    actor: r.actor_email || 'system',
    at: r.created_at,
  }));
}

module.exports = {
  KINDS, KIND_LABELS, NAME_MAX, DESCRIPTION_MAX, NEVER_GRANTABLE, MANAGE_KEY,
  grantable, grantsForRole, grantsForUser, groupsForUser, inheritanceForRole,
  list, get, impactOfDeleting,
  create, rename, remove, setRoles, setUsers, setPermissions, forgetRole, audit,
  validateName, validateKind, validatePermissions, validateRoles, validateUsers,
  mayHandOut,
};
