// What everybody did, in one place.
//
// The Activity Log answers a question none of the existing audit trails can:
// "what has this person been doing", across every part of the app. The four
// trails already in the schema — asset_events, role_permission_audit,
// ip_allowlist_audit, timesheet_events — answer the other question, "what
// happened to this thing", and they stay exactly as they are. Each remains the
// authority for its own feature's detail view. This is a second, wider index
// over the same events, not a replacement for any of them.
//
// Two ways in, and the split is the design:
//
//   the backstop   src/middleware/activity.js records EVERY successful
//                  state-changing request, from the method and the path alone.
//                  Coverage is therefore complete by construction: a route
//                  added next year is logged without anybody remembering to.
//
//   the enrichment a route calls req.activity(...) to replace the generic
//                  entry with a real description and before/after values.
//                  Only worth doing where the detail matters.
//
// The alternative — a record() call hand-written into all sixty-six
// state-changing endpoints — was rejected for one reason: it is wrong the
// moment somebody adds the sixty-seventh, and nothing fails when they do. A
// log with a silent hole in it is worse than no log, because it is trusted.

const crypto = require('crypto');
const { roleDef } = require('./roles');

/* A designation's display name, from its key. Lives here rather than being
   imported separately by every caller, and falls back to the key itself so a
   role deleted from the catalogue still reads as something in an old entry —
   which is the whole point of copying the role onto the row. */
const labelForRole = (key) => {
  if (!key) return '';
  const def = roleDef(key);
  return (def && def.label) || key;
};

/* Which part of the app a request belongs to, from its path.
 *
 * Derived rather than declared so that a new route is classified without being
 * registered anywhere. The fallback is the first path segment, which is right
 * for every mount in src/server.js and stays right for ones added later. */
const MODULE_OF = [
  [/^\/api\/assets/, 'assets'],
  [/^\/api\/projects/, 'projects'],
  [/^\/api\/project-reviews/, 'reviews'],
  [/^\/api\/clients/, 'clients'],
  [/^\/api\/users/, 'users'],
  [/^\/api\/team/, 'users'],
  [/^\/api\/timesheets/, 'timesheet'],
  [/^\/api\/permissions/, 'permissions'],
  [/^\/api\/ip-allowlist/, 'settings'],
  [/^\/api\/reference/, 'settings'],
  [/^\/api\/branding/, 'settings'],
  [/^\/api\/auth/, 'auth'],
  [/^\/api\/notifications/, 'notifications'],
];

function moduleOf(path) {
  for (const [re, name] of MODULE_OF) if (re.test(path)) return name;
  const m = /^\/api\/([a-z-]+)/.exec(String(path || ''));
  return m ? m[1].replace(/-/g, '_').slice(0, 32) : 'other';
}

/* The modules the filter offers. Built from the table above so the dropdown
   cannot list a module nothing writes to, or miss one that something does. */
const MODULES = [...new Set(MODULE_OF.map(([, name]) => name))].sort();

/* A generic description, for an action nobody has enriched.
 *
 * Deliberately plain and deliberately honest: it says what request was made
 * rather than inventing a friendly name for something this module knows
 * nothing about. Somebody reading "POST /api/assets/<id>/deliver" learns more
 * than they would from "Performed an action". */
const VERB = { POST: 'Created', PATCH: 'Updated', PUT: 'Updated', DELETE: 'Deleted' };
function describe(method, path) {
  const verb = VERB[String(method).toUpperCase()] || 'Changed';
  const tail = String(path || '').replace(/^\/api\//, '').replace(/\/$/, '');
  return `${verb}: ${tail}`;
}

/* An id in the path, when there is one — the thing being acted on. */
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
function entityIdOf(path) {
  const m = UUID.exec(String(path || ''));
  return m ? m[0] : null;
}

/* Before and after, as {field: {from, to}}.
 *
 * Only fields that actually differ are kept: an edit that touched one field of
 * twelve should read as one change, not as twelve rows of "same, same, same".
 * Values are stringified and clipped, because this column is read by people and
 * a base64 avatar in it would make the page unusable. */
function diff(before = {}, after = {}) {
  const out = {};
  const keys = [...new Set([...Object.keys(before || {}), ...Object.keys(after || {})])];
  for (const key of keys) {
    const from = normalise(before ? before[key] : undefined);
    const to = normalise(after ? after[key] : undefined);
    if (from === to) continue;
    out[key] = { from, to };
  }
  return Object.keys(out).length ? out : null;
}

const CLIP = 200;
function normalise(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (Array.isArray(value)) return value.join(', ').slice(0, CLIP);
  if (typeof value === 'object') {
    try { return JSON.stringify(value).slice(0, CLIP); } catch { return '[object]'; }
  }
  return String(value).slice(0, CLIP);
}

/* Write one entry.
 *
 * Never throws. This is the rule the whole feature depends on: recording that
 * something happened must not be able to stop it happening. A logging table
 * that can fail a delivery, a review or a sign-in is a liability, and the right
 * failure is a missing line in a report rather than a user who cannot work.
 * The error goes to the server log, where it is somebody's problem later.
 */
async function record(db, entry = {}) {
  try {
    const actor = entry.actor || {};
    await db.query(
      `INSERT INTO activity_log
         (id, actor_id, actor_name, actor_email, actor_role, module, action,
          entity_type, entity_id, entity_label, summary, changes, method, path)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        crypto.randomUUID(),
        actor.id || null,
        (actor.name || '').slice(0, 255) || null,
        (actor.email || '').slice(0, 191) || null,
        (actor.role || '').slice(0, 64) || null,
        String(entry.module || 'other').slice(0, 32),
        String(entry.action || 'unknown').slice(0, 64),
        entry.entityType ? String(entry.entityType).slice(0, 32) : null,
        entry.entityId || null,
        entry.entityLabel ? String(entry.entityLabel).slice(0, 255) : null,
        String(entry.summary || 'Action').slice(0, 500),
        entry.changes ? JSON.stringify(entry.changes).slice(0, 4000) : null,
        entry.method ? String(entry.method).slice(0, 8) : null,
        entry.path ? String(entry.path).slice(0, 255) : null,
      ]
    );
    return true;
  } catch (err) {
    console.error('[activity] could not record an entry:', err.message);
    return false;
  }
}

/* Reading it back, for the page and the exports.
 *
 * Paginated from the start rather than when it becomes a problem: this is the
 * one table in the application with no upper bound on its size, and the query
 * that works at ten thousand rows and not at ten million is the one somebody
 * writes when they assume they will revisit it. */
const PAGE_MAX = 200;

function buildQuery(filter = {}) {
  const where = [];
  const params = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };

  if (filter.actorId) add('a.actor_id = ?', filter.actorId);
  if (filter.module) add('a.module = ?', filter.module);
  if (filter.action) add('a.action = ?', filter.action);
  // Whole days, inclusive at both ends — "1st to 3rd" has to include the 3rd.
  if (filter.from) add('a.created_at >= ?', `${filter.from} 00:00:00`);
  if (filter.to) add('a.created_at <= ?', `${filter.to} 23:59:59`);
  if (filter.q) {
    const like = `%${String(filter.q).slice(0, 100)}%`;
    params.push(like, like, like);
    where.push(`(a.summary LIKE $${params.length - 2} OR a.entity_label LIKE $${params.length - 1}`
      + ` OR a.actor_name LIKE $${params.length})`);
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

module.exports = {
  MODULES, moduleOf, describe, entityIdOf, diff, normalise, record, buildQuery, PAGE_MAX,
  labelForRole,
};
