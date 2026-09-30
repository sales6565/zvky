/* Events for Dev & QA: one envelope, written to integration_outbox.
 *
 * Every event this application tells Dev & QA about goes through emit(), so every
 * one of them has the same shape:
 *
 *   {
 *     eventId,          the outbox row id; the receiver de-duplicates on it
 *     sequence,         integration_outbox.seq, added when the row is read or sent
 *     type,             e.g. "project.updated", "feedback.fix_approved"
 *     occurredAt,       ISO-8601, when the change was written
 *     source: "forge",
 *     schemaVersion: 1,
 *     projectId,        the project (Dev & QA: game) it concerns, or null for a client
 *     entity: { type, id, version },
 *     payload           the state or change, specific to the type
 *   }
 *
 * ENTITY VERSIONS are a counter per entity in integration_entity_versions, bumped in
 * the same transaction as the event. A receiver that holds version 7 of a project
 * ignores an event carrying version 6: that is how an event that arrives late, or a
 * retry of an old delivery, cannot undo a newer change. A gap (holding 5, receiving 7)
 * tells the receiver it missed one and should reconcile.
 *
 * SWITCHED OFF, NOTHING IS WRITTEN. With INTEGRATION_ENABLED unset, emit() returns
 * without writing, so a studio that never connects Dev & QA does not accumulate an
 * outbox forever. What happened meanwhile is not lost: Dev & QA's first reconciliation
 * reads the current state through the list endpoints.
 */
const crypto = require('node:crypto');

const SCHEMA_VERSION = 1;
const SOURCE = 'forge';

function enabled() {
  return /^(1|true|yes|on)$/i.test(String(process.env.INTEGRATION_ENABLED || ''));
}

/* Take the entity's version row (creating it) and lock it for this transaction, then
   return it. The INSERT ... ON DUPLICATE KEY UPDATE is what takes the lock, on a row
   that is guaranteed to exist afterwards; a SELECT ... FOR UPDATE on a row that did not
   exist yet would take a gap lock instead, and two first events for one entity would
   deadlock (the same finding as PUT /assets/:id/in-game). */
async function lockVersion(runner, entityType, entityId) {
  await runner.query(
    `INSERT INTO integration_entity_versions (entity_type, entity_id, version, state_hash)
     VALUES ($1, $2, 0, '') ON DUPLICATE KEY UPDATE version = version`,
    [entityType, String(entityId)]
  );
  const { rows } = await runner.query(
    'SELECT version, state_hash FROM integration_entity_versions WHERE entity_type = $1 AND entity_id = $2',
    [entityType, String(entityId)]
  );
  return { version: Number(rows[0].version) || 0, hash: rows[0].state_hash || '' };
}

async function currentVersion(runner, entityType, entityId) {
  const { rows } = await runner.query(
    'SELECT version FROM integration_entity_versions WHERE entity_type = $1 AND entity_id = $2',
    [entityType, String(entityId)]
  ).catch(() => ({ rows: [] }));
  return rows.length ? Number(rows[0].version) || 0 : 0;
}

/* Write one event. runner is the transaction the change itself was written on, so the
   change and the event commit together or not at all. Returns the envelope, or null
   when the integration is switched off. `hash`, when given, is stored as the entity's
   last-told state so touch() can skip an event that would say nothing new. */
async function emit(runner, { type, projectId = null, entityType, entityId, payload = {}, hash = null }) {
  if (!enabled()) return null;
  const current = await lockVersion(runner, entityType, entityId);
  const version = current.version + 1;
  await runner.query(
    `UPDATE integration_entity_versions SET version = $1, state_hash = $2
      WHERE entity_type = $3 AND entity_id = $4`,
    [version, hash === null ? current.hash : hash, entityType, String(entityId)]
  );
  const envelope = {
    eventId: crypto.randomUUID(),
    type,
    occurredAt: new Date().toISOString(),
    source: SOURCE,
    schemaVersion: SCHEMA_VERSION,
    projectId: projectId || null,
    entity: { type: entityType, id: String(entityId), version },
    payload,
  };
  await runner.query(
    `INSERT INTO integration_outbox
       (id, payload, \`status\`, event_type, entity_type, entity_id, entity_version, project_id)
     VALUES ($1, $2, 'pending', $3, $4, $5, $6, $7)`,
    [envelope.eventId, JSON.stringify(envelope), type, entityType, String(entityId), version, projectId || null]
  );
  return envelope;
}

/* ---- Clients and projects: state, not deltas ------------------------------------
 *
 * A client or project event carries the whole current record, read back after the
 * write. touch() is called after every write path in the client and project routes;
 * it compares the record with the last one told and emits only if something Dev & QA
 * can see has changed, so calling it once too often is harmless. */

const iso = (v) => (v instanceof Date ? v.toISOString() : v || null);

async function clientSnapshot(runner, id) {
  const { rows } = await runner.query(
    'SELECT id, `name`, is_active, archived_at, deal_closed_at, is_system FROM clients WHERE id = $1', [id]
  );
  const c = rows[0];
  if (!c) return null;
  return {
    id: c.id,
    name: c.name,
    isActive: Boolean(Number(c.is_active)),
    archivedAt: iso(c.archived_at),
    dealClosedAt: iso(c.deal_closed_at),
    isSystem: Boolean(Number(c.is_system)),
  };
}

async function projectSnapshot(runner, id) {
  const { rows } = await runner.query(
    `SELECT p.id, p.\`name\`, p.\`code\`, p.client_id, p.is_active, p.archived_at, p.closed_at,
            c.\`name\` AS client_name
       FROM projects p LEFT JOIN clients c ON c.id = p.client_id WHERE p.id = $1`, [id]
  );
  const p = rows[0];
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    code: p.code || null,
    clientId: p.client_id,
    clientName: p.client_name || null,
    isActive: Boolean(Number(p.is_active)),
    archivedAt: iso(p.archived_at),
    closedAt: iso(p.closed_at),
  };
}

const hashOf = (value) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

/* kind: 'client' | 'project'. created: the caller knows this write created it. */
async function touch(runner, kind, id, { created = false } = {}) {
  if (!enabled() || !id) return null;
  const snap = kind === 'client' ? await clientSnapshot(runner, id) : await projectSnapshot(runner, id);
  if (!snap) {
    const was = await lockVersion(runner, kind, id);
    if (was.hash === 'deleted') return null;
    return emit(runner, {
      type: `${kind}.deleted`, projectId: kind === 'project' ? id : null,
      entityType: kind, entityId: id, payload: { id }, hash: 'deleted',
    });
  }
  const hash = hashOf(snap);
  const current = await lockVersion(runner, kind, id);
  if (current.hash === hash) return null;   // nothing Dev & QA can see has changed
  return emit(runner, {
    type: `${kind}.${created || current.version === 0 ? 'created' : 'updated'}`,
    projectId: kind === 'project' ? id : null,
    entityType: kind, entityId: id, payload: snap, hash,
  });
}

/* Every project under a client, after a client-level write that cascades to them
   (archive and restore). */
async function touchProjectsOf(runner, clientId) {
  if (!enabled()) return;
  const { rows } = await runner.query('SELECT id FROM projects WHERE client_id = $1', [clientId]);
  for (const r of rows) await touch(runner, 'project', r.id);
}

/* Best effort after a write that has already committed: an event that could not be
   written is logged, never turned into a failure of the user's change. Dev & QA's
   periodic reconciliation repairs anything an event missed. */
function after(db, kind, id, opts) {
  if (!enabled()) return Promise.resolve(null);
  return touch(db, kind, id, opts).catch((err) => {
    console.error(`[integration-events] could not record ${kind} ${id}: ${err.sqlMessage || err.message}`);
    return null;
  });
}
function afterProjectsOf(db, clientId) {
  if (!enabled()) return Promise.resolve();
  return touchProjectsOf(db, clientId).catch((err) => {
    console.error(`[integration-events] could not record projects of ${clientId}: ${err.sqlMessage || err.message}`);
  });
}

/* Router middleware for the client and project routes: after any successful write,
   and before its answer is sent, tell Dev & QA about every record it could have
   changed. touch() skips records whose visible state did not change, so covering the
   whole router is safe and nothing new has to remember to call it.

   kind 'client': the client in the path, projects it created or cascaded to.
   kind 'project': the project in the path, or the one a POST created. */
function routeHook(kind) {
  return (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD' || !enabled()) return next();
    const send = res.json.bind(res);
    res.json = (body) => {
      if (res.statusCode >= 400) return send(body);
      const first = String(req.path || '/').split('/').filter(Boolean)[0] || null;
      const work = async () => {
        if (kind === 'client') {
          const clientId = (body && body.client && body.client.id) || (first && first !== 'bulk' ? first : null);
          if (clientId) {
            await after(db(), 'client', clientId);
            await afterProjectsOf(db(), clientId);
          }
          for (const p of [...((body && body.projects) || []), ...((body && body.added) || [])]) {
            if (p && p.id) await after(db(), 'project', p.id, { created: true });
          }
        } else {
          const projectId = (body && body.project && body.project.id) || first;
          if (projectId) await after(db(), 'project', projectId, { created: req.method === 'POST' && !first });
        }
      };
      work().finally(() => send(body));
      return res;
    };
    return next();
  };
}
const db = () => require('./db');

/* ---- Reading rows back as envelopes --------------------------------------------- */

/* A row written by emit() is stored as its envelope, and gains its sequence here. A
   row from before the envelope existed (or the test probe) is wrapped as schema
   version 0 so a reader sees one shape; its original body is the payload. */
function envelopeOf(row) {
  let stored;
  try { stored = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload; } catch {
    stored = { unparsed: String(row.payload) };
  }
  if (stored && stored.schemaVersion >= 1 && stored.eventId) {
    return { ...stored, sequence: Number(row.seq) };
  }
  return {
    eventId: row.id,
    sequence: Number(row.seq),
    type: (stored && typeof stored.event === 'string' && stored.event) || 'legacy',
    occurredAt: iso(row.created_at),
    source: SOURCE,
    schemaVersion: 0,
    projectId: (stored && stored.projectId) || null,
    entity: null,
    payload: stored,
  };
}

module.exports = {
  SCHEMA_VERSION, enabled, emit, touch, touchProjectsOf, after, afterProjectsOf,
  clientSnapshot, projectSnapshot, currentVersion, envelopeOf, hashOf, routeHook,
};
