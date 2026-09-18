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
  /* Work has been handed in, told to the people who are now waiting on it:
     whoever assigned it, and the submitter's team lead.

     THE OPPOSITE DIRECTION FROM `assigned`, and that is the point of it being
     its own kind. `assigned` travels down — somebody has given you work.
     This travels back up — the work you gave out has come back, and there is
     a review queue with your name on it. Sharing a sentence between the two
     would have told a lead "you have been assigned FX-001" about an asset
     they are supposed to be reviewing, not doing. */
  submitted: 'submitted',
  /* Somebody tagged you in a chat message.
   *
     RAISED HERE RATHER THAN ON CHAT'S OWN CHANNEL, and that is the decision
     worth recording. A chat message deliberately raises no notification row —
     the panel's own poll is its signal, and an ordinary message is not
     something waiting on anybody. Being NAMED is different: it is addressed to
     one person and it is asking them for something, which is what every other
     kind in this list has in common.
     
     It also makes the promise the studio asked for structural rather than
     remembered. Mentions are meant to reach you whatever you have done to
     quieten a conversation; because they travel on a different channel from
     chat's push, anything that ever silences a conversation would be silencing
     the other one. There is no such control today — nothing in this
     application mutes a chat or a group — so this is a property held in
     reserve rather than one in use, and a test pins it so it cannot be lost
     by accident.
     
     NO MESSAGE TEXT, like chat's own push and for the same reason: a chat body
     on a lock screen is where this application could show a private
     conversation to whoever is standing nearby. Who tagged you and where is
     enough to decide whether to go and look. */
  mention: 'mention',
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
  /* An administrator reset this account's password. Raised for the ACCOUNT
     HOLDER, never for the administrator: it is the one person who has to act
     on it, and the one person who has not just been told by doing it.
     
     The temporary password is deliberately not in here. This table is read
     back by the API and rendered in a panel; a credential in it would be a
     credential sitting in the database in plain text and on screen for as long
     as the bell keeps it. The value goes to the person who did the reset, in
     that response, once. */
  password_reset: 'password_reset',
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
  if (row.kind === KINDS.mention) {
    const who = row.other_name || 'Somebody';
    /* A group says its name. A one-to-one has no name of its own — its title
       is "whoever the other person is", which from the recipient's side is the
       person already named at the front of this sentence, so repeating it
       would read as "Priya mentioned you in Priya". */
    const where = row.conversation_title ? ` in ${row.conversation_title}` : '';
    return `${who} mentioned you${where}.`;
  }
  if (row.kind === KINDS.password_reset) {
    const who = row.other_name || 'An administrator';
    return `${who} reset your password. Choose a new one to carry on — you will be asked as soon `
      + 'as you sign in.';
  }
  const code = row.asset_code || 'An asset';
  const name = row.asset_name ? ` — ${row.asset_name}` : '';
  if (row.kind === KINDS.submitted) {
    /* The project is named here and not in the two above it, and the
       difference is who is reading. Work assigned TO you arrives in a list of
       your own tasks; you know where it is from. A submission arrives at
       somebody who hands work out across several projects and is about to
       decide what to look at next, and "which job is this" is the first thing
       they ask. */
    const where = row.project_name ? ` in ${row.project_name}` : '';
    const who = row.other_name || 'Somebody';
    return `${who} submitted ${code}${name}${where} for review.`;
  }
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
/* The same event, sent to whatever phones this person has registered.
 *
 * Hung off raise() — the choke point every bell notification already passes
 * through — so a kind added later is pushed without anybody remembering to wire
 * it up. The same reasoning that put the assignment emails here.
 *
 * FIRE AND FORGET. Nothing above waits for a phone company: the notification
 * row is already written, and a push that fails must not fail the action that
 * raised it. Errors are swallowed for that reason, not by oversight. */
function pushFor(db, { notificationId, recipientId, actorId, kind, assetId, projectId }) {
  let push;
  try { push = require('./push-notifications'); } catch { return; }
  if (!push.status().configured) return;

  Promise.resolve()
    .then(async () => {
      /* The sentence the bell would show, rebuilt from the same describe() so
         the phone and the app never disagree about what happened. */
      /* THE BELL'S OWN QUERY, not a second one written to look like it.
         SELECT is the constant every other read in this file uses, so the
         sentence on the phone is built from the same row the panel builds it
         from and the two cannot drift apart. It is declared below this
         function; JavaScript hoists the const's binding, and this runs inside a
         promise long after the module has finished loading. */
      const { rows } = await db.query(
        `${SELECT} WHERE n.id = $1`, [notificationId]
      );
      const row = rows[0];
      /* describe() returns the ONE SENTENCE the bell shows — a string, not a
         title/body pair. It becomes the push body, under a fixed title, so the
         phone shows exactly the words the app does. */
      const sentence = row ? describe(row) : null;
      await push.pushTo(db, recipientId, {
        title: 'Zvky',
        body: sentence || 'Something needs your attention.',
        tag: kind,
        data: { kind, assetId: assetId || '', projectId: projectId || '', actorId: actorId || '' },
      });
    })
    .catch(() => { /* see the note above: a push never fails the action */ });
}

async function raise(db, { recipientId, actorId, kind, assetId, projectId, otherUserId, conversationId }) {
  if (!recipientId || recipientId === actorId) return null;
  const id = uuid();
  try {
    await db.query(
      `INSERT INTO notifications (id, recipient_id, actor_id, kind, asset_id, project_id, other_user_id, conversation_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id, recipientId, actorId || null, kind, assetId || null, projectId || null,
        otherUserId || null, conversationId || null]
    );
    pushFor(db, { notificationId: id, recipientId, actorId, kind, assetId, projectId });
    return id;
  } catch (err) {
    /* A deployment whose migration has not added project_id or conversation_id
       still notifies — without the link back, which is worth more than
       silence. */
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

  /* And the email, which is a SEPARATE CHANNEL rather than a second copy of the
     rows above. Nothing about the two raise() calls changed: the bell, the
     desktop notification and Pending Actions behave exactly as they did.
     
     Here because this is the choke point — every route that changes who holds
     an asset reaches it through assignments.open() — so all four of them send
     mail without four hooks, and the fifth is covered when somebody adds it.
     
     Only the incoming half. Being told "this is no longer yours" is worth a
     line in the bell and is not worth an email; the person it LEFT has nothing
     to do about it, and mail nobody needs to act on is how a studio learns to
     ignore mail that they do.
     
     Queued, not sent: it returns immediately, and the message goes out on a
     short timer after this transaction has committed. That is what makes a bulk
     assign one email instead of forty, and it is why a mail server being down
     cannot roll back an assignment. */
  try {
    require('./email-notifications').queueAssignment({ recipientId: to, actorId, assetId });
  } catch (err) {
    console.warn(`[email] could not queue the assignment notice for ${assetId}: ${err.message}`);
  }
}

/* Work has been handed in, told to the people it is now waiting on.
 *
 * WHO. assignments.submissionAudience() — whoever assigned it and the
 * submitter's team lead — asked for rather than restated, because the
 * submission EMAIL asks the same function the same question. One definition of
 * "who cares about this", so the two channels cannot come to different answers
 * about the same submission.
 *
 * WHEN. Only from POST /assets/:id/submit, which is the only place the
 * 'submit' transition is evaluated. Accepting and starting a task raises
 * nothing: it is the same person picking up work they were already given, and
 * the people told here are the ones who now have something to DO.
 *
 * NOT TWICE FOR ONE PERSON. The audience is a Set, so a lead who also assigned
 * the work is one recipient and not two. And not twice for one submission: a
 * second submit on an asset already in a review queue is refused by the
 * workflow before this is reached, so a double-click cannot produce a second
 * round of notices. A genuine RE-submission after changes were requested is a
 * different event — a new round, waiting on them again — and does notify.
 *
 * Returns how many were raised, which is what the tests count. */
async function taskSubmitted(db, { assetId, actorId, recipientIds }) {
  let raised = 0;
  for (const recipientId of recipientIds || []) {
    /* otherUserId is the SUBMITTER, not the recipient: describe() names them
       off that join, and "Ana Artist submitted FX-001" is the whole point of
       the sentence. raise() drops a recipient who is also the actor, which is
       the second guard on a lead submitting their own work. */
    const id = await raise(db, {
      recipientId, actorId, kind: KINDS.submitted, assetId, otherUserId: actorId,
    });
    if (id) raised += 1;
  }
  return raised;
}

/* Somebody was tagged in a chat message.
 *
 * WHO. Only people the caller has already established are in the conversation
 * — chatMentions.recipients() does that filtering and drops the sender, and it
 * is asked BEFORE this, so this function tells whoever it is given and does
 * not have a second opinion about membership.
 *
 * ONE PER PERSON, not one per @. Tagging Ana three times in one sentence is
 * emphasis, not three things to tell her; idsIn() has already made the list
 * unique.
 *
 * `actorId` is also `otherUserId`, which is what lets describe() name the
 * sender off the same join every other kind uses — and what makes raise() drop
 * a mention of the person doing the mentioning, if one ever reached here. */
async function chatMention(db, { conversationId, actorId, recipientIds }) {
  let raised = 0;
  for (const recipientId of recipientIds || []) {
    const id = await raise(db, {
      recipientId, actorId, kind: KINDS.mention, conversationId, otherUserId: actorId,
    });
    if (id) raised += 1;
  }
  return raised;
}

/* COALESCE, because a row points at one or the other: an asset notification
   carries the project through the asset, a project one carries it directly. */
const SELECT = `SELECT n.id, n.seq, n.kind, n.asset_id AS assetId, n.read_at AS readAt, n.created_at AS createdAt,
       a.\`code\` AS asset_code, a.\`name\` AS asset_name,
       COALESCE(a.project_id, n.project_id) AS projectId,
       p.\`name\` AS project_name,
       c.title AS conversation_title, n.conversation_id AS conversationId,
       o.\`name\` AS other_name, o.id AS otherUserId,
       o.avatar_updated_at AS otherPhotoUpdatedAt
  FROM notifications n
  LEFT JOIN assets a ON a.id = n.asset_id
  /* On the SAME expression the line above selects, and it did not used to be.
     The join read n.project_id alone, which an asset notification never sets —
     it carries its project through the asset — so every assignment row came
     back with projectId filled in and projectName null. Nothing rendered it,
     so nothing looked broken; the submission sentence names the project, which
     is what turned a dormant gap into a visible one. */
  LEFT JOIN projects p ON p.id = COALESCE(a.project_id, n.project_id)
  /* A LEFT JOIN and no foreign key behind it, deliberately: chat arrived after
     notifications and a deployment can be part-migrated. A dangling id here
     costs the sentence its "in <group>" clause and nothing else. */
  LEFT JOIN chat_conversations c ON c.id = n.conversation_id
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
  conversationId: row.conversationId || null,
  conversationTitle: row.conversation_title || null,
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

/* Told to the account holder, and to nobody else.
 *
 * The administrator is carried as `otherUserId` so describe() names them off
 * the same join every other kind uses — a reset that arrives unattributed is
 * one the recipient cannot tell from a compromise. Also as `actorId`, which is
 * what stops it being raised at all if somebody ever routes a self-reset
 * through here: raise() drops a notification whose recipient is its actor. */
async function passwordReset(db, { userId, byId }) {
  return raise(db, {
    recipientId: userId,
    actorId: byId || null,
    kind: KINDS.password_reset,
    otherUserId: byId || null,
  });
}

module.exports = {
  passwordReset,
  projectReviewRequested,
  projectReviewAnswered,
  KINDS, describe, raise, assignmentChanged, taskSubmitted, chatMention,
  listFor, unreadCount, since, highWater, markRead, markAllRead,
};
