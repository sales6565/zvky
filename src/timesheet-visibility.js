// WHOSE TIMESHEET MAY THIS PERSON READ — asked in one place.
//
// ===========================================================================
// MOVED HERE, NOT REWRITTEN. These two functions were inside
// src/routes/timesheets.js, where they have decided the Timesheet tab's
// visibility since the daily model landed. Prompt 62 adds a download of
// everybody's timesheets, and the one thing that download must never do is
// disagree with the tab: a report that showed a line the requester cannot open
// in the UI would be a permission hole with a spreadsheet in front of it.
//
// So the router now requires them from here and the export requires the same
// module. The bodies are unchanged, comments and all; what used to be a local
// `db` and a local `holds` are now this module's imports.
//
// THREE ANSWERS, WIDENING: your own always; your team if you hold
// timesheet.team; anybody if you hold timesheet.all. "Your team" is the
// reporting line the rest of the application already uses — reports_to_id or
// team_lead_id — rather than a second idea of a team invented here.

const db = require('./db');
const { holds } = require('./permissions');

/* Whose sheet may this person open?
 *
 * Returns null — well, { ok: false } — when the answer is "no", so a caller can
 * 403 without a second lookup deciding the same thing differently.
 */
async function mayRead(viewer, targetId) {
  if (!targetId || targetId === viewer.id) return { ok: true, scope: 'own' };
  if (holds(viewer, 'timesheet.all')) return { ok: true, scope: 'all' };
  if (holds(viewer, 'timesheet.team')) {
    const { rows } = await db.query(
      'SELECT 1 AS ok FROM users WHERE id = $1 AND (reports_to_id = $2 OR team_lead_id = $2)',
      [targetId, viewer.id]
    );
    if (rows.length) return { ok: true, scope: 'team' };
  }
  return { ok: false };
}

// Everybody whose sheet this person may read, for the picker and the queue.
async function readableUserIds(viewer) {
  if (holds(viewer, 'timesheet.all')) {
    /* Everybody, deactivated accounts included. There IS an is_active on a
       user now — see src/user-deactivation.js — and this deliberately does not
       filter by it: somebody who has left still has the weeks they filled in,
       and a timesheet report that quietly dropped them would stop adding up. */
    const { rows } = await db.query('SELECT id FROM users');
    return rows.map((r) => r.id);
  }
  const mine = [viewer.id];
  if (holds(viewer, 'timesheet.team')) {
    const { rows } = await db.query(
      'SELECT id FROM users WHERE reports_to_id = $1 OR team_lead_id = $1', [viewer.id]
    );
    rows.forEach((r) => mine.push(r.id));
  }
  return [...new Set(mine)];
}

/* WHICH SCOPE THIS PERSON IS IN, as one word, for a screen that wants to say
   so. The same three the two functions above decide between. */
const scopeOf = (viewer) => (holds(viewer, 'timesheet.all') ? 'all'
  : (holds(viewer, 'timesheet.team') ? 'team' : 'own'));

module.exports = { mayRead, readableUserIds, scopeOf };
