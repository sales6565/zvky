const { asyncRouter } = require('../async-router');

// See src/async-router.js: keeps a failed query from killing the process.
const router = asyncRouter();
const { v4: uuid } = require('uuid');
const db = require('../db');
const { authenticate, requirePermission } = require('../middleware/auth');
const { canAccessProject, holds } = require('../permissions');
const submissionLink = require('../submission-link');
const notifications = require('../notifications');
const rolePermissions = require('../role-permissions');
const { roleKeys } = require('../roles');

router.use(authenticate);

/* A whole project put in front of the Creative Director.
 *
 * Deliberately NOT part of the asset pipeline, and worth being explicit about
 * because the names are close enough to be confused: an asset in CD Review is
 * one piece of work at a review gate, with an assignee, rounds and a status the
 * state machine moves. This is a link concerning the project — a deck, a
 * milestone build, a cut — with none of those. They are two queues, and mixing
 * them would have made "CD Review" mean two different things on one screen.
 *
 * So: its own table, its own two permissions, and no transition anywhere near
 * src/asset-workflow.js.
 */

const SELECT = `
  SELECT r.id, r.link, r.description, r.status, r.created_at AS createdAt,
         r.reviewed_at AS reviewedAt, r.submitter_email AS submitterEmail,
         r.reviewer_email AS reviewerEmail,
         r.client_id AS clientId, c.\`name\` AS clientName,
         r.project_id AS projectId, p.\`name\` AS projectName, p.\`code\` AS projectCode,
         r.submitted_by AS submittedById, s.\`name\` AS submittedByName,
         s.avatar_updated_at AS submittedByPhotoAt,
         r.reviewed_by AS reviewedById, v.\`name\` AS reviewedByName
    FROM project_review_requests r
    LEFT JOIN clients  c ON c.id = r.client_id
    LEFT JOIN projects p ON p.id = r.project_id
    LEFT JOIN users    s ON s.id = r.submitted_by
    LEFT JOIN users    v ON v.id = r.reviewed_by`;

// The table arrives with a migration, and a step can fail. When it has not
// arrived the queue is empty rather than a 500 — the same bargain the rest of
// this codebase makes with its newer tables.
const unavailable = (err) => err && (err.code === 'ER_NO_SUCH_TABLE' || err.code === 'ER_BAD_FIELD_ERROR');

// GET /api/project-reviews?status=pending — the queue.
//
// A SHARED queue: every holder of the permission sees every submission, because
// a submission is addressed to whoever is watching rather than to a person.
router.get('/', requirePermission('project.review_queue'), async (req, res) => {
  const wanted = req.query.status;
  const where = wanted === 'pending' || wanted === 'reviewed' ? ' WHERE r.status = $1' : '';
  try {
    const { rows } = await db.query(`${SELECT}${where} ORDER BY r.created_at DESC`,
      where ? [wanted] : []);
    const pending = rows.filter((r) => r.status === 'pending').length;
    res.json({ requests: rows, pending });
  } catch (err) {
    if (!unavailable(err)) throw err;
    console.warn(`[schema] project_review_requests unavailable (${err.code}); the queue reads empty.`);
    res.json({ requests: [], pending: 0, unavailable: true });
  }
});

// POST /api/project-reviews — submit one.
// body: { clientId, projectId, link, description? }
router.post('/', requirePermission('project.review_send'), async (req, res) => {
  const { clientId, projectId, link, description } = req.body || {};
  if (!clientId) return res.status(400).json({ error: 'Choose a client.', field: 'clientId' });
  if (!projectId) return res.status(400).json({ error: 'Choose a project.', field: 'projectId' });

  // The same link rule a submission uses, so "that is not a valid link" means
  // the same thing in both places.
  const verdict = submissionLink.validate(link);
  if (!verdict.ok) return res.status(400).json({ error: verdict.error, field: 'link' });

  const { rows: project } = await db.query('SELECT * FROM projects WHERE id = $1', [projectId]);
  if (!project.length) return res.status(400).json({ error: 'That project does not exist.', field: 'projectId' });
  if (project[0].client_id !== clientId) {
    return res.status(400).json({ error: 'That project is not under that client.', field: 'projectId' });
  }
  // Reach, not permission: the sender has to be able to open the project they
  // are submitting, the same rule every other project-scoped action applies.
  if (!(await canAccessProject(req.user, projectId))) {
    return res.status(403).json({ error: 'No access to this project' });
  }

  const id = uuid();
  try {
    await db.query(
      `INSERT INTO project_review_requests (id, client_id, project_id, link, description, submitted_by, submitter_email)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, clientId, projectId, verdict.link, String(description || '').trim() || null,
       req.user.id, req.user.email]
    );
  } catch (err) {
    if (!unavailable(err)) throw err;
    return res.status(503).json({
      error: 'Project review submissions are not available on this deployment yet — the database '
        + 'is missing project_review_requests. See /api/health.',
    });
  }

  /* Tell everybody watching the queue. Swallowed on failure for the reason the
     notifications module gives: a submission that happened and was not
     announced beats one that refused to happen because a notification could
     not be written. */
  try {
    await notifications.projectReviewRequested(db, {
      projectId, actorId: req.user.id, recipientIds: await queueWatchers(),
    });
  } catch (err) {
    console.warn(`[notifications] could not announce project review ${id}: ${err.message}`);
  }

  console.log(`${req.user.email} submitted project "${project[0].name}" for CD review (${id}).`);
  const { rows } = await db.query(`${SELECT} WHERE r.id = $1`, [id]);
  res.status(201).json({ request: rows[0] });
});

// POST /api/project-reviews/:id/reviewed — mark one done.
//
// Nothing is deleted: it leaves the pending list and stays as the record that
// it was asked for and answered, with who answered and when.
router.post('/:id/reviewed', requirePermission('project.review_queue'), async (req, res) => {
  let rows;
  try {
    ({ rows } = await db.query('SELECT * FROM project_review_requests WHERE id = $1', [req.params.id]));
  } catch (err) {
    if (!unavailable(err)) throw err;
    return res.status(404).json({ error: 'Not found' });
  }
  if (!rows.length) return res.status(404).json({ error: 'That submission does not exist.' });
  if (rows[0].status === 'reviewed') {
    const { rows: already } = await db.query(`${SELECT} WHERE r.id = $1`, [req.params.id]);
    return res.json({ request: already[0], alreadyReviewed: true });
  }

  await db.query(
    `UPDATE project_review_requests
        SET status = 'reviewed', reviewed_by = $1, reviewer_email = $2, reviewed_at = NOW()
      WHERE id = $3`,
    [req.user.id, req.user.email, req.params.id]
  );
  console.log(`${req.user.email} marked project review ${req.params.id} as reviewed.`);
  const { rows: saved } = await db.query(`${SELECT} WHERE r.id = $1`, [req.params.id]);
  res.json({ request: saved[0] });
});

/* Who is watching the queue, worked out from the permission rather than from a
 * role name — so granting it to a second designation in Settings is all it
 * takes to have them told as well. Reads the effective set per role, which is
 * the same answer authenticate() computes per request. */
async function queueWatchers() {
  const watching = [];
  for (const role of roleKeys()) {
    const held = await rolePermissions.effectiveFor(db, role).catch(() => null);
    if (held && held.has('project.review_queue')) watching.push(role);
  }
  if (!watching.length) return [];
  const { rows } = await db.query('SELECT id FROM users WHERE `role` IN ($1)', [watching]);
  return rows.map((r) => r.id);
}

module.exports = router;
