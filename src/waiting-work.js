/* WHAT IS WAITING ON ONE PERSON — the figure on the follow-up row, and the list
 * behind it, from the same predicate.
 *
 * ===========================================================================
 * WHAT THE FIGURE COUNTED BEFORE THIS CHANGE, because it is not what the label
 * said and the difference is the point of this file.
 *
 * src/follow-up.js's heldCounts() counts assets whose ASSIGNMENT EPISODE
 * overlaps the day — `asset_assignments.assigned_at < end AND (ended_at IS NULL
 * OR ended_at > start)` — with NO STATUS FILTER AT ALL. An episode ends only on
 * reassignment, unassignment or delivery (see the schema's note on
 * ended_reason), so an asset the person submitted three days ago and which is
 * now sitting in TL Review still counted toward "N waiting on them".
 *
 * That is a true statement about what is on their desk in the ledger sense —
 * "held that day" — and a false one under the words the row prints for today,
 * "waiting on them": work in TL Review is waiting on a REVIEWER.
 *
 * So the figure for TODAY now comes from this file, and heldCounts() keeps its
 * job for a PAST DATE, where it is a reconstruction this one cannot make. The
 * section already told the two apart — heldLabel has always switched on the
 * date — and now the numbers agree with the words. The report states the size
 * of the change.
 *
 * ===========================================================================
 * THE DEFINITION, AND IT RESTATES NOTHING.
 *
 * Two questions, both already answered in this application:
 *
 *   IS IT ON THIS PERSON'S DESK?   src/asset-workflow.js's `assignee` actor,
 *                                  which is the predicate the workflow itself
 *                                  uses to decide whether this person may act:
 *
 *       assignee_id = them
 *       AND (routed_to_id = them
 *            OR (routed_to_id IS NULL
 *                AND status IN ASSIGNEE_STATUSES))
 *
 *                                  The second branch is the CD Feedbacks relay:
 *                                  that state is routed to NOBODY until the lead
 *                                  passes it on, and without the status list
 *                                  "routed to nobody" would read as "routed to
 *                                  anybody". ASSIGNEE_STATUSES is imported, not
 *                                  retyped.
 *
 *   IS IT THEIRS TO ACT ON NOW?    'assigned' — given and not started — plus
 *                                  src/permissions.js's REWORK_STATUSES, the
 *                                  studio's existing list of "waiting for
 *                                  rework": TL Feedbacks, CD Feedbacks and
 *                                  Game Feedback. Also imported.
 *
 * WHAT FALLS OUT OF THAT, rather than being filtered for:
 *
 *   in_progress            NOT in the list. They have started it; the clock is
 *                          running and nothing is waiting. Somebody with a timer
 *                          on one asset still has the others waiting, which is
 *                          the whole reason this is per asset.
 *   not_started            NOT in the list. Assignment moves an asset to
 *                          'assigned'; a not_started asset has not been given to
 *                          anybody yet.
 *   every review state     NOT in the list. TL Review, CD Review, Approved for
 *                          Client, Awaiting Client Feedback and Delivered are
 *                          waiting on somebody else or on nobody.
 *   outsourced work        CANNOT appear, and this is a property of the schema
 *                          rather than a filter. The two assignment routes are
 *                          mutually exclusive — outsourceBlocked() refuses while
 *                          assignee_id is set and internalAssignBlocked() refuses
 *                          while a live outsource assignment exists — so an asset
 *                          out with a freelancer has assignee_id NULL and matches
 *                          nothing here. The test asserts the premise, so a future
 *                          relaxation of exclusivity cannot quietly start counting
 *                          freelance work as somebody's queue.
 *
 * ===========================================================================
 * ONE PREDICATE, ONE PLACE. whereFor() below writes the WHERE clause, and both
 * the count and the list build their query around it. The figure and the panel
 * therefore cannot disagree: there is nothing for them to disagree about.
 */

const workflow = require('./asset-workflow');
const { REWORK_STATUSES } = require('./permissions');
const referenceData = require('./reference-data');

/* The statuses that mean "this person has something to do and has not done it".
   'assigned' first because it is the common case. */
const WAITING_STATUSES = ['assigned', ...REWORK_STATUSES];

/* Of those, the ones that are this person's even when the asset is routed to
   nobody — derived from the workflow's own list rather than written out, so a
   status moving into or out of ASSIGNEE_STATUSES moves here with it. */
const UNROUTED_STATUSES = WAITING_STATUSES.filter((s) => workflow.ASSIGNEE_STATUSES.includes(s));

/* THE PREDICATE, as SQL, with its parameters pushed onto the caller's list.
 *
 * Written once. `alias` is the assets table's alias in the caller's query, and
 * `user` is either a single id or a list of them — the count asks about forty
 * people in one query and the list asks about one. */
function whereFor(params, { alias = 'a', user, projectIds = null, studioWide = true }) {
  const parts = [];
  params.push(user);
  parts.push(`${alias}.assignee_id IN ($${params.length})`);

  params.push(WAITING_STATUSES);
  parts.push(`${alias}.\`status\` IN ($${params.length})`);

  /* THE DESK TEST. The same two branches as the workflow's `assignee` actor,
     and the second one is why UNROUTED_STATUSES exists. */
  params.push(user);
  const routed = `${alias}.routed_to_id IN ($${params.length})`;
  params.push(UNROUTED_STATUSES);
  const unrouted = `(${alias}.routed_to_id IS NULL AND ${alias}.\`status\` IN ($${params.length}))`;
  parts.push(`(${routed} OR ${unrouted})`);

  /* SCOPE. Not optional and not defaulted to "everything" by accident: a caller
     that forgets it would show a viewer work in projects they cannot open.
     studioWide is the only way past it, and it is the role's own projectScope. */
  if (!studioWide) {
    params.push(projectIds || []);
    parts.push(`${alias}.project_id IN ($${params.length})`);
  }
  return parts.join('\n        AND ');
}

/* ---------------------------------------------------------------------------
 * THE FIGURE, for every row on the list, in one query.
 *
 * Set-based and grouped, so it costs the same for one person as for forty —
 * which is what keeps it inside the follow-up section's own query budget. It
 * replaces heldCounts() for TODAY only; see the header.
 */
async function countsFor(db, userIds, { projectIds = [], studioWide = true } = {}) {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return new Map();
  /* A narrower viewer with no projects can see nothing, and asking would be a
     query whose answer is already known — the same early return heldCounts has. */
  if (!studioWide && !projectIds.length) return new Map();

  const params = [];
  const where = whereFor(params, { alias: 'a', user: ids, projectIds, studioWide });
  const { rows } = await db.query(
    `SELECT a.assignee_id AS userId, COUNT(*) AS n
       FROM assets a
      WHERE ${where}
      GROUP BY a.assignee_id`,
    params
  );
  return new Map(rows.map((r) => [r.userId, Number(r.n) || 0]));
}

/* ---------------------------------------------------------------------------
 * THE LIST, for one person, in ONE query.
 *
 * Grouped in JavaScript from one flat read rather than by walking clients and
 * then projects and then assets, which is the N+1 the budget test forbids.
 *
 * THE TWO CORRELATED SUBQUERIES ARE PART OF THE SAME STATEMENT, so this is one
 * round trip however many assets come back. They answer "how long has it been
 * waiting on this person", which is two facts and not one:
 *
 *   since it reached them   the open assignment episode's assigned_at. A
 *                           reassignment mid-rework restarts the wait, because
 *                           for the new person it is new work.
 *   since it reached this   the asset_events row that moved it INTO its current
 *   state                   status. A lead sending it back restarts the wait for
 *                           the same person, because what they are waiting to do
 *                           has changed.
 *
 * THE LATER OF THE TWO is the answer, and the row carries both so the panel can
 * say which. "Waiting 3 days" measured from an assignment that predates the
 * feedback would be a figure that makes the studio look slower than it is;
 * measured from the status change alone it would reset a long-held asset the
 * moment anybody touched it.
 */
async function listFor(db, userId, { projectIds = [], studioWide = true } = {}) {
  if (!userId) return [];
  if (!studioWide && !projectIds.length) return [];
  const params = [];
  const where = whereFor(params, { alias: 'a', user: [userId], projectIds, studioWide });
  const { rows } = await db.query(
    `SELECT a.id, a.\`code\`, a.\`name\`, a.\`type\`, a.\`status\`, a.priority,
            a.due_date AS dueDate, a.project_id AS projectId, a.routed_to_id AS routedToId,
            p.\`name\` AS projectName, p.\`code\` AS projectCode,
            p.client_id AS clientId, c.\`name\` AS clientName,
            (SELECT MAX(aa.assigned_at) FROM asset_assignments aa
              WHERE aa.asset_id = a.id AND aa.user_id = a.assignee_id
                AND aa.ended_at IS NULL) AS heldSince,
            (SELECT MAX(ev.created_at) FROM asset_events ev
              WHERE ev.asset_id = a.id AND ev.to_status = a.\`status\`) AS stateSince
       FROM assets a
       JOIN projects p ON p.id = a.project_id
       /* LEFT, and the reason is in the report: projects.client_id is NOT NULL
          with a RESTRICT key, so a missing client cannot be created through the
          API — but ensureClients() logs "the foreign key is still missing" on a
          database whose earlier boot could not create it, so a dangling id is
          reachable on a legacy deployment. An INNER join would silently drop
          that project's assets out of a figure the row beside it still counted,
          which is the one failure this panel exists to make impossible. */
       LEFT JOIN clients c ON c.id = p.client_id
      WHERE ${where}`,
    params
  );
  return rows;
}

/* ---------------------------------------------------------------------------
 * ONE ROW, AS THE PANEL READS IT.
 */
const MS_PER_DAY = 86400000;

/* A DATETIME column as an instant — the same reading src/follow-up.js gives,
   and here for the same reason: the driver builds Date objects in the server's
   local zone out of values that are UTC. */
function stampMs(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return value;
  if (value instanceof Date) {
    return Date.UTC(value.getFullYear(), value.getMonth(), value.getDate(),
      value.getHours(), value.getMinutes(), value.getSeconds(), value.getMilliseconds());
  }
  const text = String(value).trim().replace(' ', 'T');
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? text : `${text}Z`);
  return Number.isNaN(ms) ? null : ms;
}

/* A DATE column as the ISO day it is. due_date is a DATE: the driver hands it
   back as a Date in the server's local zone, which for a date-only value is a
   day boundary waiting to go wrong. */
function isoDay(value) {
  if (!value) return null;
  if (typeof value === 'string') return value.slice(0, 10);
  if (value instanceof Date) {
    return `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-`
      + `${String(value.getDate()).padStart(2, '0')}`;
  }
  return String(value).slice(0, 10);
}

/* The type's display name, from the studio's own list. Falls back to the key so
   a retired type still reads as something. */
function typeLabel(key) {
  const entry = referenceData.get('asset_types', key);
  return (entry && entry.label) || key || '';
}

function shape(row, { today, now }) {
  const held = stampMs(row.heldSince);
  const state = stampMs(row.stateSince);
  /* THE LATER OF THE TWO, and null only when neither is recorded — an asset
     assigned before asset_assignments existed, with no event for its current
     status. The panel then says "unknown" rather than printing a wait of
     fifty-six years. */
  const since = held === null ? state : (state === null ? held : Math.max(held, state));
  const due = isoDay(row.dueDate);
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    typeLabel: typeLabel(row.type),
    status: row.status,
    statusLabel: workflow.label(row.status),
    priority: row.priority,
    dueDate: due,
    /* OVERDUE IS A COMPARISON OF CALENDAR DAYS, not of instants: a thing due
       today is not overdue at nine in the morning and is not overdue at six in
       the evening either. The studio's day is IST everywhere else in this
       application and `today` is handed in from the section's own clock. */
    overdue: Boolean(due && due < today),
    dueInDays: due ? Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / MS_PER_DAY) : null,
    waitingSince: since === null ? null : new Date(since).toISOString(),
    waitingDays: since === null ? null : Math.max(0, Math.floor((now - since) / MS_PER_DAY)),
    /* Which of the two the wait is measured from, so the panel can say "since
       assigned" or "since it reached TL Feedbacks" rather than an unexplained
       number. */
    waitingFrom: since === null ? null : (state !== null && (held === null || state >= held) ? 'status' : 'assigned'),
    projectId: row.projectId,
    projectName: row.projectName,
    projectCode: row.projectCode,
    clientId: row.clientId || null,
    clientName: row.clientName || null,
  };
}

/* ---------------------------------------------------------------------------
 * CLIENT, THEN PROJECT, THEN ASSETS — with the totals on the headings.
 *
 * SORTED OVERDUE FIRST, THEN LONGEST WAITING, at every level: the assets inside
 * a project, the projects inside a client, and the clients. A panel whose
 * groups were alphabetical while its rows were by urgency would make somebody
 * scroll past two tidy clients to find the one that is on fire.
 *
 * A PROJECT WITH NO READABLE CLIENT lands in its own group, LAST, named so the
 * reader knows it is a gap in the data rather than a client called nothing.
 */
const NO_CLIENT = '__none__';
const NO_CLIENT_LABEL = 'No client';

/* OVERDUE FIRST, THEN LONGEST WAITING, THEN BY NAME — one comparator, used for
   the rows inside a project AND for the cap's own ordering, so the fifty the
   panel keeps are the fifty at the top of the list it draws. The last clause is
   what makes the order stable between draws, so two equally urgent rows do not
   swap places under somebody's cursor. */
const assetUrgency = (a, b) => (Number(b.overdue) - Number(a.overdue))
  || ((b.waitingDays || 0) - (a.waitingDays || 0))
  || String(a.name || '').localeCompare(String(b.name || ''));

function group(assets) {
  const byClient = new Map();
  for (const asset of assets) {
    const key = asset.clientId && asset.clientName ? asset.clientId : NO_CLIENT;
    const client = byClient.get(key) || {
      id: key === NO_CLIENT ? null : asset.clientId,
      name: key === NO_CLIENT ? NO_CLIENT_LABEL : asset.clientName,
      unknown: key === NO_CLIENT,
      projects: new Map(),
      total: 0,
      overdue: 0,
    };
    const project = client.projects.get(asset.projectId) || {
      id: asset.projectId,
      name: asset.projectName,
      code: asset.projectCode || null,
      assets: [],
      total: 0,
      overdue: 0,
    };
    project.assets.push(asset);
    project.total += 1;
    if (asset.overdue) project.overdue += 1;
    client.projects.set(asset.projectId, project);
    client.total += 1;
    if (asset.overdue) client.overdue += 1;
    byClient.set(key, client);
  }

  const urgency = assetUrgency;
  const groupUrgency = (a, b) => (b.overdue - a.overdue)
    || (b.total - a.total)
    || String(a.name || '').localeCompare(String(b.name || ''));

  const clients = [...byClient.entries()].map(([key, client]) => ({
    ...client,
    projects: [...client.projects.values()]
      .map((p) => ({ ...p, assets: p.assets.slice().sort(urgency) }))
      .sort(groupUrgency),
    _last: key === NO_CLIENT,
  }));
  /* The unknown-client group is pinned last whatever its urgency: it is a note
     about the data, and a reader scanning from the top should meet real clients
     first. */
  clients.sort((a, b) => (Number(a._last) - Number(b._last)) || groupUrgency(a, b));
  return clients.map(({ _last, ...rest }) => rest);
}

/* HOW MANY ASSETS THE PANEL HANDS OVER before it has to be asked for the rest.
 *
 * Fifty, which is two or three screenfuls of a panel that opens under one row.
 * The total travels with it, so the heading is honest about what it is showing,
 * and "show all" lifts the cap on the next request rather than sending a
 * studio's worth of rows to a panel that will draw a fifth of them. Deliberately
 * larger than the section's own ROW_CAP of 25: this is the detail somebody opened
 * on purpose, not a list they are scanning. */
const ASSET_CAP = 50;

/* ---------------------------------------------------------------------------
 * THE WHOLE PANEL, for one person.
 *
 * `count` is computed from the SAME rows the groups are built from, so it is
 * the number the row's button printed by construction — not a second count that
 * happens to agree. The figure on the row comes from countsFor() above, which
 * shares this file's one predicate.
 */
async function panelFor(db, userId, { projectIds = [], studioWide = true, today, now = Date.now(), all = false } = {}) {
  const rows = await listFor(db, userId, { projectIds, studioWide });
  const assets = rows.map((r) => shape(r, { today, now }));

  /* THE CAP IS APPLIED TO THE FLAT LIST IN URGENCY ORDER AND THEN GROUPED, not
     to each group — capping per group would show a few of each client and call
     it fifty, which is a different list from "the fifty most urgent". */
  const ordered = assets.slice().sort(assetUrgency);
  const visible = all ? ordered : ordered.slice(0, ASSET_CAP);

  return {
    /* COUNTED FROM THE SAME ROWS THE GROUPS ARE BUILT FROM, so it is the number
       the row's button printed by construction rather than a second count that
       happens to agree. countsFor() above and listFor() here share one
       predicate, which is what leaves nothing for them to disagree about. */
    count: assets.length,
    shownCount: visible.length,
    more: assets.length - visible.length,
    cap: ASSET_CAP,
    overdue: assets.filter((a) => a.overdue).length,
    clients: group(visible),
    today,
  };
}

/* WHAT THE PANEL TELLS THE READER "WAITING" MEANS, in one sentence, from the
   server — so the help line and the predicate cannot drift apart. */
const EXPLAINER = 'Waiting means the asset is assigned to this person and on their desk with '
  + 'something for them to do: Assigned and not started, or sent back to them as TL Feedbacks, '
  + 'CD Feedbacks or Game Feedback. An asset they have started (In Progress) is not waiting, '
  + 'nor is anything sitting with a reviewer, nor work out with a freelancer.';

module.exports = {
  WAITING_STATUSES, UNROUTED_STATUSES, ASSET_CAP, NO_CLIENT_LABEL, EXPLAINER,
  whereFor, countsFor, listFor, panelFor, group, shape, stampMs, isoDay, typeLabel,
  assetUrgency,
};
