// Archiving, closing, and what each of those stops.
//
// Four states across two records, and they are deliberately independent axes:
//
//   archived  — out of the way. Nothing is destroyed: the projects, their
//               assets, every submission and every review decision are all
//               still in the database, and unarchiving brings them back
//               exactly as they were. This is what "delete" does to anything
//               with records under it, following the convention the value
//               lists already set (see src/reference-data.js): something in use
//               is deactivated, never deleted, and what depends on it keeps
//               working.
//   closed    — a project whose work is finished. It takes no new assets and
//               its existing ones are read-only.
//   deal closed — a client whose engagement is finished. No new projects go
//               under it. Its existing projects are NOT touched: closing a
//               deal is a commercial fact, and work in flight on it is a
//               separate decision somebody makes per project.
//
// Hard delete survives for the one case where it destroys nothing: a client
// with no projects, or a project with no assets. That is the same rule
// reference-data applies to a value nothing uses.

const ASSET_DONE = 'delivered';

// --- what stops what -----------------------------------------------------------

// A project accepts new work and edits to existing work.
function projectIsOpen(project) {
  return Boolean(project) && Boolean(project.is_active) && !project.closed_at;
}

// Why a project is refusing, in the words somebody needs to fix it.
function projectRefusal(project) {
  if (!project) return 'That project does not exist.';
  if (!project.is_active) return `${project.name} is archived. Restore it to work on it again.`;
  if (project.closed_at) return `${project.name} is closed. Reopen it to make changes.`;
  return null;
}

function clientTakesNewProjects(client) {
  return Boolean(client) && Boolean(client.is_active) && !client.deal_closed_at;
}

function clientRefusal(client) {
  if (!client) return 'That client does not exist.';
  if (!client.is_active) return `${client.name} is archived. Restore it before adding projects.`;
  if (client.deal_closed_at) return `The deal with ${client.name} is closed, so it takes no new projects. Reopen it first.`;
  return null;
}

// --- what has to be dealt with first -------------------------------------------

// Archiving a client with live projects under it is the case worth stopping:
// somebody almost always means "this engagement is over", which is the deal
// status, not "hide all of this work". So it is refused, with the count and an
// explicit way to go ahead anyway.
async function activeProjectsUnder(db, clientId) {
  const { rows } = await db.query(
    'SELECT id, `name` FROM projects WHERE client_id = $1 AND is_active = 1 AND closed_at IS NULL',
    [clientId]
  );
  return rows;
}

// An asset is "in flight" until it has been delivered. Archiving or closing a
// project holding some is refused unless the caller says to go ahead.
async function unfinishedAssets(db, projectId) {
  const { rows } = await db.query(
    'SELECT COUNT(*) AS n FROM assets WHERE project_id = $1 AND `status` <> $2',
    [projectId, ASSET_DONE]
  );
  return Number(rows[0].n);
}

// The shape both routes answer with when they want a second look before acting.
function needsConfirmation(message, detail) {
  return { ok: false, status: 409, requiresConfirmation: true, error: message, ...detail };
}

module.exports = {
  ASSET_DONE,
  projectIsOpen,
  projectRefusal,
  clientTakesNewProjects,
  clientRefusal,
  activeProjectsUnder,
  unfinishedAssets,
  needsConfirmation,
};
