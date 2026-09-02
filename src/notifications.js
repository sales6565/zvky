// Telling somebody that work moved.
//
// One row per person per event, stored rather than pushed, because a
// notification that only existed as a live pop-up is one that anybody away from
// their desk never got. The header list reads the table; the toast is a
// convenience layered on top of it.
//
// WHY THIS IS RAISED FROM assignments.open(). Three routes change who holds an
// asset — creating one with somebody on it, PATCHing the assignee, and the
// hand-over out of TL Review, TL Feedbacks or CD Feedbacks — and all three already
// funnel through that one function, because it is what opens and closes the
// episode. Hooking the three call sites would work today and would silently
// miss the fourth path somebody adds next year. Hooking the choke point cannot.
//
// Failing to notify must never fail the assignment. The write goes in the same
// transaction so it cannot be half-done, but a missing table — a deployment
// that has not run the migration — is swallowed the way the rest of this
// codebase swallows one, because somebody being reassigned and told nothing is
// a much smaller problem than a reassignment that refuses to happen.

const { v4: uuid } = require('uuid');

/* Two kinds, deliberately distinct.
 *
 * The person picking work up and the person it left are told different things,
 * and giving them one shared wording would produce "FX-001 was reassigned" in
 * both inboxes, which reads as an accusation in one of them and a task in the
 * other. */
const KINDS = {
  assigned: 'assigned',            // it is yours now
  unassigned: 'unassigned',        // it is no longer yours
  // A whole project submitted for the Creative Director to look at. Not an
  // asset moving anywhere — see src/routes/project-reviews.js.
  project_review: 'project_review',
  // And their answer to it, which Production acts on.
  project_review_feedback: 'project_review_feedback',
  /* The same event told to the person who ASKED. A different sentence because
     it is a different fact: for a queue watcher the feedback is work arriving,
     for the submitter it is the answer they were waiting for — and the one
     thing they then have to do with it is read it and close the thread. */
  project_review_answered: 'project_review_answered',
  /* Raised by the version that asked the Creative Director to choose between
     requesting changes and approving. Nothing writes these any more — one
     "Submit Feedback" replaced the two buttons — but rows carrying them are in
     people's bells, so they keep their sentences below. */
  project_review_changes: 'project_review_changes',
  project_review_approved: 'project_review_approved',
};

const unavailable = (err) => err && (err.code === 'ER_NO_SUCH_TABLE' || /doesn't exist/i.test(err.message || ''));

/* What the person actually reads.
 *
 * Built here rather than stored pre-rendered so a later wording change applies
 * to the whole history, and so the asset's code and name stay accurate if they
 * are edited after the fact — the row keeps ids, the sentence is made from
 * them. */
function describe(row) {
  if (row.kind === KINDS.project_review) {
    const project = row.project_name || 'A project';
    return row.other_name
      ? `${row.other_name} submitted ${project} for your review.`
      : `${project} has been submitted for your review.`;
  }
  if (row.kind === KINDS.project_review_answered) {
    const project = row.project_name || 'a project';
    const who = row.other_name ? row.other_name : 'The Creative Director';
    return `${who} has answered your submission on ${project} — read it and close the thread.`;
  }
  if (row.kind === KINDS.project_review_feedback) {
    const project = row.project_name || 'a project';
    const who = row.other_name ? row.other_name : 'The Creative Director';
    return `${who} has given feedback on ${project}.`;
  }
  if (row.kind === KINDS.project_review_changes) {
    const project = row.project_name || 'a project';
    const who = row.other_name ? `${row.other_name} has` : 'The Creative Director has';
    return `${who} asked for changes on ${project}.`;
  }
  if (row.kind === KINDS.project_review_approved) {
    const project = row.project_name || 'A project';
    const who = row.other_name ? `${row.other_name} approved` : 'Approved';
    return `${who} ${project} for the client.`;
  }
  const code = row.asset_code || 'An asset';
  const name = row.asset_name ? ` — ${row.asset_name}` : '';
  if (row.kind === KINDS.unassigned) {
    return row.other_name
      ? `${code}${name} has moved to ${row.other_name}.`
      : `${code}${name} is no longer assigned to you.`;
  }
  return row.other_name
    ? `${row.other_name} assigned you ${code}${name}.`
    : `You have been assigned ${code}${name}.`;
}

/* Raise one. `recipientId` of null, or a recipient who is also the actor, is
 * dropped: telling somebody they assigned something to themselves is noise, and
 * it is the common case when a lead picks up their own work. */
async function raise(db, { recipientId, actorId, kind, assetId, projectId, otherUserId }) {
  if (!recipientId || recipientId === actorId) return null;
  const id = uuid();
  try {
    await db.query(
      `INSERT INTO notifications (id, recipient_id, actor_id, kind, asset_id, project_id, other_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, recipientId, actorId || null, kind, assetId || null, projectId || null, otherUserId || null]
    );
    return id;
  } catch (err) {
    /* A deployment whose migration has not added project_id still notifies —
       without the link back to the project, which is worth more than silence. */
    if (err.code === 'ER_BAD_FIELD_ERROR') {
      try {
        await db.query(
          `INSERT INTO notifications (id, recipient_id, actor_id, kind, asset_id, other_user_id)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [id, recipientId, actorId || null, kind, assetId || null, otherUserId || null]
        );
        return id;
      } catch (e2) { if (unavailable(e2)) return null; throw e2; }
    }
    if (unavailable(err)) return null;
    throw err;
  }
}

/* Everybody watching the project review queue, told at once.
 *
 * A shared queue: every holder of project.review_queue is a recipient, because
 * the submission is not addressed to an individual. The submitter is skipped by
 * raise() when they happen to hold it themselves. */
async function projectReviewRequested(db, { projectId, actorId, recipientIds }) {
  for (const recipientId of recipientIds || []) {
    await raise(db, { recipientId, actorId, kind: KINDS.project_review, projectId, otherUserId: actorId });
  }
}

/* The Creative Director's feedback, told to two audiences at once.
 *
 * Everybody watching the queue — Production among them, since acting on it is
 * their job — and the person who submitted it, who until now was told nothing.
 * They could hold none of the queue permissions and so appear in no recipient
 * list, which meant the one person actually waiting on the answer was the one
 * person not informed it had arrived.
 *
 * Two kinds rather than one, because they are two different facts: work has
 * arrived for the queue, and your answer is ready for the submitter. The
 * submitter is told whatever else they hold — they asked the question, so they
 * hear the answer; a permission decides what somebody may DO, and being told
 * that a thing you started has finished is not an action.
 *
 * `only` keeps the submitter out of the watcher loop, so somebody who is both
 * gets the sentence addressed to them and not two rows for one event. raise()
 * already skips the actor, which is what stops a Creative Director who is also
 * a watcher from being told about their own answer. */
async function projectReviewAnswered(db, { projectId, actorId, recipientIds, submitterId }) {
  if (submitterId) {
    await raise(db, {
      recipientId: submitterId, actorId, kind: KINDS.project_review_answered,
      projectId, otherUserId: actorId,
    });
  }
  const only = (recipientIds || []).filter((id) => id !== submitterId);
  for (const recipientId of only) {
    await raise(db, {
      recipientId, actorId, kind: KINDS.project_review_feedback, projectId, otherUserId: actorId,
    });
  }
}

/* Both halves of a hand-over, in one call.
 *
 * `from` may be null (nothing was assigned before) and `to` may be null (the
 * asset was unassigned entirely). Both are ordinary cases rather than errors,
 * and each side is raised only if there is somebody to tell. */
async function assignmentChanged(db, { assetId, from, to, actorId }) {
  if (from === to) return;
  await raise(db, { recipientId: to, actorId, kind: KINDS.assigned, assetId, otherUserId: actorId });
  await raise(db, { recipientId: from, actorId, kind: KINDS.unassigned, assetId, otherUserId: to });
}

/* COALESCE, because a row points at one or the other: an asset notification
   carries the project through the asset, a project one carries it directly. */
const SELECT = `SELECT n.id, n.seq, n.kind, n.asset_id AS assetId, n.read_at AS readAt, n.created_at AS createdAt,
       a.\`code\` AS asset_code, a.\`name\` AS asset_name,
       COALESCE(a.project_id, n.project_id) AS projectId,
       p.\`name\` AS project_name,
       o.\`name\` AS other_name, o.id AS otherUserId,
       o.avatar_updated_at AS otherPhotoUpdatedAt
  FROM notifications n
  LEFT JOIN assets a ON a.id = n.asset_id
  LEFT JOIN projects p ON p.id = n.project_id
  LEFT JOIN users o ON o.id = n.other_user_id`;

const shape = (row) => ({
  id: row.id,
  seq: Number(row.seq),
  kind: row.kind,
  message: describe(row),
  assetId: row.assetId,
  assetCode: row.asset_code || null,
  projectId: row.projectId || null,
  projectName: row.project_name || null,
  otherUserId: row.otherUserId || null,
  otherName: row.other_name || null,
  otherPhotoUpdatedAt: row.otherPhotoUpdatedAt || null,
  read: Boolean(row.readAt),
  readAt: row.readAt || null,
  createdAt: row.createdAt,
});

/* Newest first. Read and unread together, because a list that hid what you had
   already seen would lose the thread of what happened this morning. */
async function listFor(db, userId, { limit = 30 } = {}) {
  const { rows } = await db.query(
    `${SELECT} WHERE n.recipient_id = $1 ORDER BY n.seq DESC LIMIT ${Number(limit) || 30}`,
    [userId]
  ).catch((err) => { if (unavailable(err)) return { rows: [] }; throw err; });
  return rows.map(shape);
}

async function unreadCount(db, userId) {
  const { rows } = await db.query(
    'SELECT COUNT(*) AS n FROM notifications WHERE recipient_id = $1 AND read_at IS NULL',
    [userId]
  ).catch((err) => { if (unavailable(err)) return { rows: [{ n: 0 }] }; throw err; });
  return Number(rows[0].n) || 0;
}

/* Anything raised since the browser last looked.
 *
 * The cursor is the sequence number of the last row the client saw, not a
 * timestamp. created_at only has second precision, and a reassignment writes
 * two rows in the same second — so `created_at > cursor` would drop any
 * notification unlucky enough to land in the same second as the previous poll,
 * permanently, with nothing to show it had happened. A sequence cannot do that.
 *
 * `highWater` gives the client its next cursor even when nothing is new, so it
 * does not have to hold a stale one across a quiet hour. */
async function since(db, userId, cursor) {
  const from = Number(cursor);
  if (!Number.isFinite(from)) return [];
  const { rows } = await db.query(
    `${SELECT} WHERE n.recipient_id = $1 AND n.seq > $2 ORDER BY n.seq ASC LIMIT 20`,
    [userId, from]
  ).catch((err) => { if (unavailable(err)) return { rows: [] }; throw err; });
  return rows.map(shape);
}

// The newest sequence this person has, or 0. The starting cursor.
async function highWater(db, userId) {
  const { rows } = await db.query(
    'SELECT COALESCE(MAX(seq), 0) AS seq FROM notifications WHERE recipient_id = $1',
    [userId]
  ).catch((err) => { if (unavailable(err)) return { rows: [{ seq: 0 }] }; throw err; });
  return Number(rows[0].seq) || 0;
}

/* Marking read is scoped to the recipient in the WHERE clause, not checked
   first and then written — so there is no window in which somebody could mark
   another person's notification read, and no second query to get wrong. */
/* How many rows an UPDATE touched.
 *
 * src/db.js returns { rows, result }: `rows` is the array for a SELECT and an
 * empty array for an UPDATE, with the driver's OkPacket on `result`. Reading
 * the count off `rows` therefore always gave zero, which made "mark as read"
 * report that it had marked nothing while quietly working. */
const affected = (out) => Number((out && out.result && out.result.affectedRows) || 0);

async function markRead(db, userId, ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
  if (!list.length) return 0;
  const out = await db.query(
    'UPDATE notifications SET read_at = NOW() WHERE recipient_id = $1 AND read_at IS NULL AND id IN ($2)',
    [userId, list]
  ).catch((err) => { if (unavailable(err)) return null; throw err; });
  return affected(out);
}

async function markAllRead(db, userId) {
  const out = await db.query(
    'UPDATE notifications SET read_at = NOW() WHERE recipient_id = $1 AND read_at IS NULL',
    [userId]
  ).catch((err) => { if (unavailable(err)) return null; throw err; });
  return affected(out);
}

module.exports = {
  projectReviewRequested,
  projectReviewAnswered,
  KINDS, describe, raise, assignmentChanged,
  listFor, unreadCount, since, highWater, markRead, markAllRead,
};
