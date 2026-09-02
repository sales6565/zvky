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
  SELECT r.id, r.link, r.description, r.status, r.feedback, r.created_at AS createdAt,
         r.reviewed_at AS reviewedAt, r.submitter_email AS submitterEmail,
         r.reviewer_email AS reviewerEmail,
         r.closed_at AS closedAt, r.closer_email AS closerEmail,
         r.acknowledged_at AS acknowledgedAt, r.acknowledger_email AS acknowledgerEmail,
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

/* The one status the Creative Director's answer now sets.
 *
 * ANSWERED is wider than that on purpose: it is every status meaning "the
 * Creative Director has dealt with this and Production has not". The two older
 * values are rows written when the answer was a choice between Request Changes
 * and Approve for Client. Those rows are history — somebody really did make
 * that decision — so they are not rewritten, and they keep appearing in
 * Production's queue exactly as they did. New answers are all FEEDBACK_GIVEN.
 */
const FEEDBACK_GIVEN = 'feedback_given';
const ANSWERED = [FEEDBACK_GIVEN, 'changes_requested', 'approved_for_client'];

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
  const KNOWN = ['pending', ...ANSWERED];
  const where = KNOWN.includes(wanted) ? ' WHERE r.status = $1' : '';
  try {
    const { rows } = await db.query(`${SELECT}${where} ORDER BY r.created_at DESC`,
      where ? [wanted] : []);
    const pending = rows.filter((r) => r.status === 'pending').length;
    // Answered and still needing somebody to do something about it.
    const answered = rows.filter((r) => ANSWERED.includes(r.status)).length;
    res.json({ requests: rows, pending, answered });
  } catch (err) {
    if (!unavailable(err)) throw err;
    console.warn(`[schema] project_review_requests unavailable (${err.code}); the queue reads empty.`);
    res.json({ requests: [], pending: 0, answered: 0, unavailable: true });
  }
});

/* GET /api/project-reviews/pending-actions — what is waiting on YOU.
 *
 * Two questions, deliberately separate:
 *
 *   pending.view            may they open this at all — the studio's own toggle,
 *                           so the tab can be given or withheld on its own
 *   project.review_respond  ->  submissions still waiting to be answered
 *   project.review_queue    ->  answers Production has not dealt with yet
 *   project.review_mine     ->  what THIS person sent, whatever became of it
 *
 * The first decides whether there is a tab; the rest decide what is IN it.
 * Holding the first alone is an empty tab, not somebody else's queue.
 *
 * The last group is different in kind from the other two and the difference is
 * load-bearing: it is a RECORD, not a queue. Nothing in it is waiting on the
 * reader, nothing in it can be acted on, and — see `countable` below — nothing
 * in it counts toward the tab's badge.
 *
 * Somebody holding both — Super Admin holds the whole catalogue — sees both
 * groups, which is exactly the "all pending items regardless of role" the
 * studio asked for, and falls out rather than being special-cased.
 *
 * `groups` is a list on purpose. This is scoped to the project review workflow
 * today; another kind of pending item is another entry in it, and the tab
 * renders whatever it is given.
 */
router.get('/pending-actions', requirePermission('pending.view'), async (req, res) => {
  const mayRespond = holds(req.user, 'project.review_respond');
  const mayFollowUp = holds(req.user, 'project.review_queue');
  const maySeeOwn = holds(req.user, 'project.review_mine');
  if (!mayRespond && !mayFollowUp && !maySeeOwn) {
    // Not an error: this is "nothing is waiting on you", which is what somebody
    // outside this workflow should be told rather than being refused.
    return res.json({ groups: [], counts: { active: 0, history: 0 }, count: 0 });
  }

  let rows = [];
  try {
    ({ rows } = await db.query(`${SELECT} ORDER BY r.created_at DESC`));
  } catch (err) {
    if (!unavailable(err)) throw err;
    return res.json({ groups: [], counts: { active: 0, history: 0 }, count: 0, unavailable: true });
  }

  /* --- Active and History ---------------------------------------------------

     One rule, and it is about MEANING rather than about which column it reads:

         Active  = the part this person owes has not been done
         History = it has

     The studio proposed reading the status field alone, uniformly, which is
     uniform in mechanism but comes apart for Production: every row they ever
     see is feedback_given, so status alone puts their entire workload under
     "History" and leaves "Active" permanently empty — and, since the badge
     counts Active only, kills their notification along with it. The words would
     mean the opposite of what they say for one of the three roles.

     Production already has the completion step that makes this unnecessary:
     "Done, actioned" (POST /:id/close) has been there since the tab shipped and
     writes closed_at. So the split needs nothing new built, and every role gets
     the same sentence:

         Creative Director   answered it yet?
         Production          finished with it yet?
         Submitter           has it been answered yet?

     `phase` is what the page reads to place a group; `countable` is what the
     badge reads. A record — anything with act 'none' — never counts, because
     nothing in it is asking for anything. */
  const groups = [];
  const mine = (r) => r.submittedById && r.submittedById === req.user.id;

  if (mayRespond) {
    /* Waiting on you to answer — and NOT the ones you sent.
     *
     * This is the bug the studio reported twice, and the gate was never the
     * problem: the feedback box is drawn for every row in this group, and this
     * group was filtered on status alone. Who submitted a row never entered
     * the decision, so anyone holding both permissions got a feedback box on
     * their own submission.
     *
     * That is not a rare configuration. project.review_send ships to Super
     * Admin alone, and Super Admin holds review_respond like every other
     * permission — so on a studio that has not granted sending to anybody
     * else, the ONLY account that can submit the form is guaranteed to see the
     * button on what it submitted. It looked like a permission that had not
     * taken effect. It was a queue that included you.
     *
     * The rule is about self-review rather than about permissions, which is
     * why it belongs here and not in the gate: nobody answers their own
     * submission, whatever they hold. Holding review_respond still means "you
     * answer these" — it just no longer means "you answer your own".
     */
    groups.push({
      key: 'awaiting_review',
      label: 'Waiting on your review',
      note: 'Projects submitted for the Creative Director. Read them and write your feedback.',
      act: 'respond',
      phase: 'active',
      items: rows.filter((r) => r.status === 'pending' && !mine(r)),
    });
    /* What they have answered. By reviewed_by rather than by status, so a
       second Creative Director's History is theirs and not the department's —
       "what I have dealt with" is the question this tab answers. */
    groups.push({
      key: 'reviewed_by_me',
      label: 'You gave feedback on',
      note: 'Submissions you have answered. Kept in full — the feedback you wrote is still here.',
      act: 'none',
      phase: 'history',
      countable: false,
      items: rows.filter((r) => ANSWERED.includes(r.status)
        && r.reviewedById && r.reviewedById === req.user.id),
    });
  }
  if (mayFollowUp) {
    /* Answered and not yet dealt with — including the rows written back when
       the answer was one of two decisions. What the feedback MEANS is now
       Production's reading of it rather than a status, so everything answered
       lands in one list. */
    groups.push({
      key: 'awaiting_followup',
      label: 'Waiting on you to act',
      note: 'The Creative Director has given feedback. Read it and take it where it goes — route '
        + 'the assets it applies to, or carry it toward delivery — then mark it done.',
      act: 'close',
      phase: 'active',
      items: rows.filter((r) => ANSWERED.includes(r.status) && !r.closedAt),
    });
    groups.push({
      key: 'followup_done',
      label: 'Dealt with',
      note: 'Routed or carried forward, and marked done. Here for good — nothing is deleted.',
      act: 'none',
      phase: 'history',
      countable: false,
      items: rows.filter((r) => ANSWERED.includes(r.status) && r.closedAt),
    });
  }
  if (maySeeOwn) {
    /* Everything this person has sent, at every status, oldest decision and
       newest alike — the studio asked for a running record rather than an
       outbox that empties. Filtered by the id and not the address, so a
       renamed account keeps its history.

       Split across the two sub-tabs by whether it has been answered, which is
       the only thing a submitter is waiting on. `act: 'none'` is what the page
       reads to draw these without any control: there is no action a submitter
       takes on their own submission. */
    groups.push({
      key: 'my_submissions',
      label: 'Sent by you',
      note: 'With the Creative Director now. Yours to follow, not to act on.',
      act: 'none',
      phase: 'active',
      /* NOT counted in the badge, and this is the point of the flag rather
         than an optimisation. The badge means "things waiting on you"; these
         are waiting on somebody else. Counted, a submitter's tab would light
         up on their first submission and stay lit until it was answered, for
         something they can do nothing about. */
      countable: false,
      items: rows.filter((r) => mine(r) && r.status === 'pending'),
    });
    /* Answered, and the submitter has not said they have read it.
     *
     * The one group in the submitter's half that IS an action, and therefore
     * the one that counts: the answer they asked for has arrived and reading
     * it is theirs to do. It stays Active until they say so — an answer that
     * filed itself away the moment it was written would be an answer nobody
     * had to read.
     *
     * The same shape Production already has: arrives in Active when the
     * feedback lands, leaves when a person says they are done with it. */
    groups.push({
      key: 'my_to_acknowledge',
      label: 'Feedback for you',
      note: 'The Creative Director has answered. Read it, then close the thread.',
      act: 'acknowledge',
      phase: 'active',
      items: rows.filter((r) => mine(r) && ANSWERED.includes(r.status) && !r.acknowledgedAt),
    });
    groups.push({
      key: 'my_answered',
      label: 'Sent by you · closed',
      note: 'What you sent, what came back, and when you closed it off. Kept in full, for as '
        + 'long as the record exists.',
      act: 'none',
      phase: 'history',
      countable: false,
      items: rows.filter((r) => mine(r) && ANSWERED.includes(r.status) && r.acknowledgedAt),
    });
  }

  /* The badge counts what is waiting on this person and nothing else: Active
     only, records excluded. History never contributes — it is by definition
     the part already done. */
  const counts = {
    active: groups.filter((g) => g.phase === 'active' && g.countable !== false)
      .reduce((n, g) => n + g.items.length, 0),
    history: groups.filter((g) => g.phase === 'history')
      .reduce((n, g) => n + g.items.length, 0),
  };
  res.json({ groups, counts, count: counts.active });
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

/* POST /api/project-reviews/:id/feedback — the Creative Director's answer.
 *
 * ONE action, and the studio asked for it deliberately. It used to be two —
 * Request Changes and Approve for Client — and the two set two statuses that
 * Production then saw as two differently-worded rows.
 *
 * What was lost by collapsing them, stated plainly: the system no longer knows
 * whether an answer means "fix this" or "this is clear". What was NOT lost is
 * anything that acted on that knowledge, because nothing did — the close step
 * accepted either status identically, and routing changes to assets was always
 * a human reading the feedback and using the reassignment flow. The distinction
 * was a label on a row, and it is now a sentence in the feedback, which is
 * where the studio wants the judgement to live.
 *
 * So feedback is REQUIRED. Under two buttons an approval could carry no words,
 * because the button said what it meant. With one button the words are the
 * whole message, and an empty one would tell Production only that somebody
 * looked at it.
 *
 * WHAT THIS DOES NOT DO, and it is still the whole design: it touches no asset.
 * The submission is project-level and names no asset, so setting every asset
 * under the project to CD Feedbacks would overwrite work that is Delivered, Not
 * Assigned or mid-flight on something unrelated. The feedback is recorded here,
 * Production reads it, and Production decides which assets it applies to —
 * through the reassignment flow they already use. A human maps the feedback to
 * the work; this does not guess.
 */
router.post('/:id/feedback', requirePermission('project.review_respond'), async (req, res) => {
  const note = String((req.body || {}).feedback || '').trim();
  if (!note) {
    return res.status(400).json({
      error: 'Write your feedback — it is the whole of what Production will act on.',
      field: 'feedback',
    });
  }

  let rows;
  try {
    ({ rows } = await db.query('SELECT * FROM project_review_requests WHERE id = $1', [req.params.id]));
  } catch (err) {
    if (!unavailable(err)) throw err;
    return res.status(404).json({ error: 'Not found' });
  }
  if (!rows.length) return res.status(404).json({ error: 'That submission does not exist.' });

  /* Nobody answers their own submission.
   *
   * Enforced here as well as hidden from the queue above, because a rule that
   * only removes a button is not a rule — it is a button that is hard to find.
   * Applies to every role including Super Admin: this is not a permission
   * anybody can be granted, it is a thing that makes no sense to do.
   */
  if (rows[0].submitted_by && rows[0].submitted_by === req.user.id) {
    return res.status(403).json({
      error: 'You sent this one — somebody else gives the feedback on it.',
      field: 'feedback',
    });
  }

  if (rows[0].status !== 'pending') {
    // Already answered. Not an error — two people opening the same queue is
    // ordinary — but the first answer stands.
    const { rows: already } = await db.query(`${SELECT} WHERE r.id = $1`, [req.params.id]);
    return res.json({ request: already[0], alreadyAnswered: true });
  }

  await db.query(
    `UPDATE project_review_requests
        SET status = $1, feedback = $2, reviewed_by = $3, reviewer_email = $4, reviewed_at = NOW()
      WHERE id = $5`,
    [FEEDBACK_GIVEN, note, req.user.id, req.user.email, req.params.id]
  );

  try {
    await notifications.projectReviewAnswered(db, {
      projectId: rows[0].project_id, actorId: req.user.id, recipientIds: await queueWatchers(),
      /* The person who asked. Read from the row rather than from the queue,
         because they need hold none of the queue permissions — and until this
         was passed, the one person waiting on the answer was the one person not
         told it had arrived. */
      submitterId: rows[0].submitted_by,
    });
  } catch (err) {
    console.warn(`[notifications] could not announce the feedback on ${req.params.id}: ${err.message}`);
  }

  console.log(`${req.user.email} gave feedback on project review ${req.params.id} — ${note}`);
  const { rows: saved } = await db.query(`${SELECT} WHERE r.id = $1`, [req.params.id]);
  res.json({ request: saved[0] });
});

/* POST /api/project-reviews/:id/acknowledge — the submitter has read the answer.
 *
 * Restricted to the person who sent that particular submission, and to them
 * alone: this is not "may you close these", it is "this one is yours". Holding
 * project.review_mine lets you see your own record; it does not make anybody
 * else's record yours to close, so the check is on the row and not on a
 * permission. Super Admin included — an acknowledgement by somebody who was
 * not waiting on the answer records something that did not happen.
 *
 * Separate from Production's close for the same reason both exist: two people
 * have to be finished with a submission, and each is only finished when they
 * say so. One does not imply the other, in either direction.
 */
router.post('/:id/acknowledge', requirePermission('project.review_mine'), async (req, res) => {
  let rows;
  try {
    ({ rows } = await db.query('SELECT * FROM project_review_requests WHERE id = $1', [req.params.id]));
  } catch (err) {
    if (!unavailable(err)) throw err;
    return res.status(404).json({ error: 'Not found' });
  }
  if (!rows.length) return res.status(404).json({ error: 'That submission does not exist.' });

  if (!rows[0].submitted_by || rows[0].submitted_by !== req.user.id) {
    return res.status(403).json({
      error: 'Only the person who sent this can close it off.',
    });
  }
  if (rows[0].status === 'pending') {
    return res.status(409).json({
      error: 'There is nothing to acknowledge yet — the Creative Director has not answered this.',
    });
  }
  if (rows[0].acknowledged_at) {
    // Already done. Not an error, and the first one stands, same as closing.
    const { rows: already } = await db.query(`${SELECT} WHERE r.id = $1`, [req.params.id]);
    return res.json({ request: already[0], alreadyAcknowledged: true });
  }

  await db.query(
    `UPDATE project_review_requests
        SET acknowledged_by = $1, acknowledger_email = $2, acknowledged_at = NOW()
      WHERE id = $3`,
    [req.user.id, req.user.email, req.params.id]
  );
  console.log(`${req.user.email} acknowledged the feedback on project review ${req.params.id}.`);
  const { rows: saved } = await db.query(`${SELECT} WHERE r.id = $1`, [req.params.id]);
  res.json({ request: saved[0] });
});

/* POST /api/project-reviews/:id/close — Production has dealt with it.
 *
 * The feedback has been read and acted on — routed to the assets it applies to,
 * or carried toward delivery, whichever it turned out to mean. Which of those it
 * was is not recorded, because the studio asked for that judgement to live in
 * Production's hands rather than in a status. Gated on project.review_queue, which
 * is the permission Production is given to read these in the first place —
 * acting on what you can see is not a second decision worth a second toggle.
 *
 * Nothing is deleted. It leaves the pending list and stays as the record, with
 * who closed it and when, beside who submitted it and who answered it.
 */
router.post('/:id/close', requirePermission('project.review_queue'), async (req, res) => {
  let rows;
  try {
    ({ rows } = await db.query('SELECT * FROM project_review_requests WHERE id = $1', [req.params.id]));
  } catch (err) {
    if (!unavailable(err)) throw err;
    return res.status(404).json({ error: 'Not found' });
  }
  if (!rows.length) return res.status(404).json({ error: 'That submission does not exist.' });
  if (rows[0].status === 'pending') {
    return res.status(409).json({
      error: 'The Creative Director has not given feedback on this yet — there is nothing to act on.',
    });
  }
  if (rows[0].closed_at) {
    const { rows: already } = await db.query(`${SELECT} WHERE r.id = $1`, [req.params.id]);
    return res.json({ request: already[0], alreadyClosed: true });
  }

  await db.query(
    `UPDATE project_review_requests
        SET closed_by = $1, closer_email = $2, closed_at = NOW()
      WHERE id = $3`,
    [req.user.id, req.user.email, req.params.id]
  );
  console.log(`${req.user.email} closed off project review ${req.params.id} (${rows[0].status}).`);
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
