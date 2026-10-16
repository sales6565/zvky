/* WHICH FOLDERS A PERSON MAY SEE, AND WHERE A PROJECT'S WORK LIVES.
 *
 * ===========================================================================
 * THE LINK IS THE MAPPING. A project manager pastes the folder link they
 * already use — the same notation an artist pastes on submit — and everything
 * follows from it. There is no derived folder name and no editable mapping
 * table any more, and that is a correction rather than a simplification: a
 * derived name is a guess about a share that already exists, and a studio's
 * folder is called "ALPHA 2024 (final)" because somebody named it that in 2024.
 *
 * A project with no link is the normal state — every project in production has
 * none — and in that state nothing about this feature is available for it.
 *
 * ===========================================================================
 * SCOPING. A non-admin does not see the share. They see a VIRTUAL LIST OF THEIR
 * PROJECTS, built from visibleProjects() — the one function in this application
 * that answers "which projects may this person be aware of", so the Server tab
 * inherits every rule the rest of the app has, including the Acting Team Lead
 * rule, with nothing to keep in step. Opening one starts at that project's
 * folder and they can never go above it: the breadcrumb stops there and the
 * server refuses a path outside it.
 *
 * server.browse_all is the one exception, and it is a wider PREFIX ('' — the
 * root) rather than a way around the check.
 */
const permissions = require('./permissions');
const serverSettings = require('./server-settings');
const serverLink = require('./server-link');
const paths = require('./server-paths');

/* Every project this person may see that has a usable link.
 *
 * `invalid` is kept rather than dropped so the Settings overview and a Super
 * Admin's own listing can SAY why a project is not available — "no server
 * link" and "its link is not under the prefix" are different problems with
 * different fixes, and a project that silently vanished from the tab is a
 * support ticket. */
async function projectsFor(db, user) {
  const prefix = serverSettings.linkPrefix();
  const rows = await permissions.visibleProjects(user);
  const valid = [];
  const invalid = [];
  for (const project of rows) {
    const link = project.server_link || null;
    if (!link) { invalid.push({ projectId: project.id, name: project.name, link: null, why: 'no server link' }); continue; }
    const checked = serverLink.validateLink(link, prefix);
    if (!checked.ok) {
      invalid.push({ projectId: project.id, name: project.name, link, why: checked.error || checked.reason });
      continue;
    }
    valid.push({
      projectId: project.id,
      name: project.name,
      link,
      relative: checked.relative,
      submitEnabled: serverSettings.submitUploadEnabledFor(project),
    });
  }
  return { valid, invalid, prefix };
}

/* THE PREFIXES THIS PERSON MAY REACH. */
async function allowedPrefixes(db, user) {
  const shared = serverSettings.current().sharedFolders;
  if (permissions.holds(user, 'server.browse_all')) {
    return { all: true, prefixes: [''], projects: [], invalid: [], shared };
  }
  const { valid, invalid } = await projectsFor(db, user);
  const prefixes = valid.map((p) => p.relative);
  for (const name of shared) if (!prefixes.includes(name)) prefixes.push(name);
  return { all: false, prefixes, projects: valid, invalid, shared };
}

/* Is this path inside any prefix this person holds? Segment-wise and
   case-insensitive — src/server-paths.js says why that rule lives on this side
   of the wall, and a test pins it against the gateway's own. */
function mayReach(prefixes, relative) {
  const want = String(relative === undefined || relative === null ? '' : relative);
  return (prefixes || []).some((p) => paths.within(want, p));
}

/* What the tab shows at the top: the person's projects, by name, with the link
 * as a subtitle — answered from Forge's own database rather than from the share,
 * because a non-admin may not read the share's root at all. It names folders
 * and says nothing about what is in them.
 *
 * A Super Admin (browse_all) gets the real root listing instead, plus the
 * projects whose link is missing or wrong, tagged — so the person who can fix
 * it is the person who can see it. */
async function roots(db, user) {
  // `projects` is what allowedPrefixes calls the usable ones; naming it `valid`
  // here is how the first version of this read undefined.
  const { projects, invalid, shared } = await allowedPrefixes(db, user);
  const all = permissions.holds(user, 'server.browse_all');
  const entries = [
    /* THE PROJECT'S NAME, NOT THE FOLDER'S. The first version of this read the
       last segment of the link, which is the name somebody typed on a folder in
       2019 — "EP01_old", "Beta", "Project 3 FINAL". What everybody in Forge
       calls that project is its name, and the whole point of this screen is to
       be a list of projects rather than a view of the share. The link is shown
       underneath, so an admin can still see exactly where it points. */
    ...projects.map((p) => ({
      name: p.name,
      path: p.relative,
      type: 'folder',
      kind: 'project',
      projectId: p.projectId,
      label: p.name,
      subtitle: p.link,
    })),
    ...shared.map((name) => ({ name, path: name, type: 'folder', kind: 'shared', label: name, subtitle: null })),
  ];
  return {
    all,
    entries,
    shared,
    // Only ever shown to somebody who could act on it.
    unavailable: all || permissions.holds(user, 'settings.server.manage') ? invalid : [],
  };
}

/* THE PERSON'S OWN FOLDER, assigned once and then fixed.
 *
 * On the first upload, and never recomputed: the point of it is that one
 * person's work is in one place, so a renamed account must not start a second
 * folder. The UNIQUE key on the column is what makes the collision handling
 * safe under two simultaneous first uploads — the loser gets a duplicate-key
 * error and takes the suffixed name rather than two people sharing a folder,
 * which is the one thing the own-folder rule exists to prevent. */
async function userFolderFor(db, user) {
  if (!user || !user.id) return { ok: false, error: 'No account.' };
  const { rows } = await db.query('SELECT server_folder, `name` FROM users WHERE id = $1', [user.id]);
  if (!rows.length) return { ok: false, error: 'No such account.' };
  if (rows[0].server_folder) return { ok: true, folder: rows[0].server_folder, created: false };

  const base = serverLink.userFolderName(rows[0].name || user.name, user.id);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = attempt === 0 ? base : serverLink.withSuffix(base, user.id + attempt);
    try {
      const { result } = await db.query(
        'UPDATE users SET server_folder = $1 WHERE id = $2 AND server_folder IS NULL',
        [candidate, user.id]
      );
      if (result && Number(result.affectedRows) === 0) {
        const { rows: now } = await db.query('SELECT server_folder FROM users WHERE id = $1', [user.id]);
        if (now.length && now[0].server_folder) return { ok: true, folder: now[0].server_folder, created: false };
      } else {
        return { ok: true, folder: candidate, created: true };
      }
    } catch (err) {
      if (err && (err.code === 'ER_DUP_ENTRY' || err.errno === 1062)) continue;
      throw err;
    }
  }
  return { ok: false, error: 'Could not assign a folder for that account.' };
}

/* The read-only overview for Settings → Server. Every project, its link,
   whether the link is usable and why not, and when it was last uploaded to.
   READ-ONLY on purpose: the link is edited on the project, beside the project's
   other fields, by whoever edits projects — not in two places. */
async function overview(db) {
  const prefix = serverSettings.linkPrefix();
  const { rows } = await db.query(
    `SELECT p.id, p.\`name\`, p.server_link, p.server_submit_enabled, p.is_active,
            c.\`name\` AS client_name
       FROM projects p
       LEFT JOIN clients c ON c.id = p.client_id
      ORDER BY p.is_active DESC, c.\`name\`, p.\`name\``
  );
  /* The last upload is read per project from the audit trail by RELATIVE path,
     not by the link — the events store the path the gateway was given, which is
     the relative one. Done in a second pass rather than in SQL because the
     relative path is computed by the shared function, and a LIKE built from a
     link would be a second implementation of "what is this project's folder". */
  const out = [];
  for (const row of rows) {
    const checked = row.server_link ? serverLink.validateLink(row.server_link, prefix) : null;
    const relative = checked && checked.ok ? checked.relative : null;
    let lastUpload = null;
    if (relative) {
      const { rows: last } = await db.query(
        `SELECT MAX(at) AS at FROM server_events
          WHERE action IN ('upload_completed', 'upload_started') AND (path = $1 OR path LIKE $2)`,
        [relative, `${relative}/%`]
      ).catch(() => ({ rows: [{ at: null }] }));
      lastUpload = last[0] ? last[0].at : null;
    }
    out.push({
      projectId: row.id,
      name: row.name,
      client: row.client_name || null,
      active: Boolean(Number(row.is_active)),
      link: row.server_link || null,
      relative,
      valid: Boolean(relative),
      why: relative ? null : (row.server_link ? (checked.error || checked.reason) : 'no server link'),
      submitEnabled: Boolean(Number(row.server_submit_enabled)),
      lastUpload,
    });
  }
  return out;
}

/* Setting a project's link. Validated, warned about, and audited by the caller.
   Nothing is created, moved or deleted on the share — see the note in
   src/routes/projects.js where the confirmation lives. */
async function setLink(db, projectId, link) {
  const prefix = serverSettings.linkPrefix();
  const raw = String(link === undefined || link === null ? '' : link).trim();
  if (!raw) {
    await db.query('UPDATE projects SET server_link = NULL WHERE id = $1', [projectId]);
    return { ok: true, link: null, relative: null, warnings: [] };
  }
  if (!prefix) {
    return { ok: false, status: 409, code: 'no_prefix',
      error: 'No server link prefix has been set in Settings → Server, so a project link cannot be checked yet.' };
  }
  const checked = serverLink.validateLink(raw, prefix);
  if (!checked.ok) return { ok: false, status: 400, error: checked.error, reason: checked.reason };

  const { rows: others } = await db.query(
    'SELECT id, `name`, server_link FROM projects WHERE server_link IS NOT NULL AND id <> $1', [projectId]
  );
  const warnings = serverLink.overlapWarnings(checked.relative, others.map((o) => {
    const theirs = serverLink.validateLink(o.server_link, prefix);
    return { name: o.name, relative: theirs.ok ? theirs.relative : null };
  }));
  await db.query('UPDATE projects SET server_link = $1 WHERE id = $2', [checked.link, projectId]);
  return { ok: true, link: checked.link, relative: checked.relative, warnings };
}

module.exports = { projectsFor, allowedPrefixes, mayReach, roots, userFolderFor, overview, setLink };
