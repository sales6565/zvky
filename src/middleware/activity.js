// Records every state-changing request that succeeded.
//
// Why a middleware rather than a record() call in each route: there are
// sixty-six state-changing endpoints today. Wiring each by hand gives a log
// that is complete on the day it ships and quietly wrong from the first
// endpoint added afterwards — and nothing fails when that happens. The hole is
// invisible, and the log goes on being trusted. Here, coverage is a property of
// the mount rather than of anybody's diligence.
//
// The routes still say more where more is worth saying: req.activity(...)
// replaces the generic entry with a description and before/after values. That
// is enrichment on top of guaranteed coverage, which is the right way round.
//
// Three deliberate exclusions, none of them a state change worth a line:
//
//   GET and HEAD        reads. Point 1 of the brief, and the reason the log
//                       stays legible — page views would bury the actions.
//   4xx and 5xx         nothing happened. A refused request is not an action,
//                       and logging every failed validation would make the
//                       page mostly noise about typos.
//   the log's own reads /api/activity is a GET, so it is already excluded, but
//                       naming it here says it is on purpose: a log that
//                       records being read fills itself up.
const activity = require('../activity');
const db = require('../db');

const CHANGES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/* Requests that change something but are not worth a person's attention.
 *
 * Marking a notification read is a state change, and logging it would put a
 * line in the studio's activity record every time somebody glanced at the bell.
 * That is the difference between a log of what people DID and a log of what
 * their browser did, and the second one is unreadable. */
const IGNORE = [
  /^\/api\/notifications\/[^/]*\/?read/,
  /^\/api\/notifications\/read-all/,
  /^\/api\/auth\/tour-seen/,
];

function activityLogger(req, res, next) {
  let enrichment = null;
  /* The handle a route uses to say what really happened. Called during the
     request; read after it, once the status is known — so a route that
     enriches and then fails still records nothing. */
  req.activity = (detail) => { enrichment = { ...(enrichment || {}), ...(detail || {}) }; };
  req.activitySkip = () => { enrichment = { skip: true }; };

  res.on('finish', () => {
    try {
      if (!CHANGES.has(req.method)) return;
      if (res.statusCode >= 400) return;
      const path = req.originalUrl.split('?')[0];
      if (IGNORE.some((re) => re.test(path))) return;
      if (enrichment && enrichment.skip) return;

      /* The actor. req.user for anything behind authenticate(); a route that
         runs without one — signing in, bootstrapping — passes its own, because
         it knows who it just became. */
      const actor = (enrichment && enrichment.actor) || req.user || null;
      /* No actor at all means an unauthenticated state change, which is either
         the bootstrap or something wrong. Recorded either way, with the actor
         blank, because "somebody unidentified did this" is exactly the entry a
         person auditing this table would want to see. */
      const e = enrichment || {};
      /* Not awaited — the response has already gone out, and holding the
         handler open to write a log line would make every action slower for no
         benefit. Caught explicitly for the same reason it is not awaited:
         nothing is watching this promise, so a rejection escaping here would
         be an unhandled rejection, and in this Node version that takes the
         whole server process down. record() already swallows its own errors;
         this is the second latch on the same door, because the failure it
         prevents is the server dying rather than a line going missing. */
      activity.record(db, {
        actor: actor || {},
        module: e.module || activity.moduleOf(path),
        action: e.action || `${activity.moduleOf(path)}.${req.method.toLowerCase()}`,
        entityType: e.entityType || null,
        entityId: e.entityId || activity.entityIdOf(path),
        entityLabel: e.entityLabel || null,
        summary: e.summary || activity.describe(req.method, path),
        changes: e.changes || null,
        method: req.method,
        path,
      }).catch((err) => console.error('[activity] could not record an entry:', err.message));
    } catch (err) {
      // Never let recording an action interfere with having performed it.
      console.error('[activity] middleware:', err.message);
    }
  });

  next();
}

module.exports = { activityLogger };
