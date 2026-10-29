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
  /* The studio closed with this person's timer still running, so it was put
     down for them at the cutoff.
     
     Raised FOR the assignee and by nobody: there is no actor, because no
     person did this — the clock did. That is exactly why it needs saying. A
     hold is something you remember doing; a timer stopped at seven by a rule
     is something you find out about the next morning, and finding out by
     noticing an hour is missing is the outcome this exists to prevent. */
  work_paused: 'work_paused',
  /* And picked up again the next working morning, for the same person and by
     the same nobody.
     
     Needs saying at least as much as the pause does, and for the opposite
     reason: a clock that is running again without anybody starting it is time
     being recorded against somebody who may not be at their desk yet. Telling
     them is what makes that a decision the studio took rather than something
     that happened to them. */
  work_resumed: 'work_resumed',
  /* SOMETHING IS WRONG WITH THE STUDIO'S EMAIL, told to the Super Admins.
   *
     THE ONE NOTIFICATION KIND THAT EXISTS BECAUSE AN EMAIL COULD NOT BE SENT,
     and that is the whole point of it: the alert about a broken mail connection
     cannot itself be an email. src/email-outbox.js raises this and queues the
     email too, so a Super Admin hears once immediately and once more when
     sending recovers — never a loop, because the in-app half cannot fail the way
     the email half can.
     
     IT CARRIES NO DETAIL, and that is deliberate rather than a limitation of
     raise(): the specifics belong on the Settings screen, where the person can
     act on them, and a notification row is read back into a bell and pushed to a
     phone. "What is wrong with the mail" is not something to put on a lock
     screen, and a reason string is exactly where a token or an address would
     eventually be pasted by somebody adding a line. */
  email_trouble: 'email_trouble',
  /* A LEAD NUDGED SOMEBODY, from the Admin Dashboard's "People to follow up".
   *
     TWO KINDS AND NOT ONE, because they are two different requests: one says
     "pick something up today", the other says "the paperwork for a day that is
     over is missing". A studio that wanted the first and not the second would
     have no way to tell them apart if they shared a kind, and neither would the
     person receiving them.

     THE SENTENCE IS STORED, which is new for this table and is the one thing
     about these two kinds worth reading twice. Every other kind's wording is
     rebuilt by describe() from the row's LINKS — the asset, the project, the
     other person — because the wording is a function of them. These two carry
     facts that are not links and are not reconstructable later: how many tasks
     were waiting at the moment of the nudge, and which day's timesheet was
     missing. Recomputing "you have 4 tasks waiting" when the bell is opened
     next week would quietly rewrite the message somebody was sent.

     So notifications.detail holds the sentence, and describe() prints it. The
     column is nullable and no other kind writes it; a deployment whose
     migration has not reached it still delivers the notice, without the detail,
     through the same fall-back raise() already had for project_id. */
  start_reminder: 'start_reminder',
  timesheet_reminder: 'timesheet_reminder',
  /* A reviewer sent work back to the artist with changes required, and routed it
     to them.
   *
     THE FIRST NOTIFICATION ON THE WAY BACK DOWN. `assigned` says work is yours,
     `submitted` says work you gave out has come back; this says work you had
     FINISHED is yours again, which is the one of the three somebody is least
     expecting and most needs told. Before it, a lead's feedback reached the
     artist only if they happened to open the asset — the review decision raised
     nothing at all.
     
     NO FEEDBACK TEXT, like `mention` and for the same reason: this is rendered
     in a bell and pushed to a lock screen, and a lead's unvarnished notes on
     somebody's work are not something to show whoever is standing nearby. Who
     asked and which asset is enough to decide to go and read it; the text is on
     the asset, where the artist has to go anyway to act on it. */
  changes_requested: 'changes_requested',
  /* Somebody recorded a leave or an idle mark against your day, or undid one.
     Its own kind rather than a detail on another, because it is addressed to
     one person and it is telling them something about their own attendance —
     which nothing else in this list does. */
  day_status: 'day_status',
  /* A VACATION WAS BOOKED, CANCELLED, ENDED EARLY, APPROVED OR REJECTED.
   *
   * A SEPARATE KIND FROM day_status EVEN THOUGH A VACATION IS MADE OF DAY
   * STATUS ROWS, and the reason is the direction it travels. day_status is
   * addressed to one person about their OWN attendance — "you were marked on
   * leave" — and its fall-back sentence says so. This one mostly travels the
   * other way: to a lead, about somebody else's booking, so that they can plan
   * the fortnight. Sharing the kind would mean a lead's bell saying "your day
   * was marked as leave" about an artist's holiday, which is the same mistake
   * `assigned` and `submitted` are two kinds to avoid.
   *
   * THE SENTENCE IS CARRIED IN `detail`, like the reminder kinds: who, which
   * dates, and which of the five things happened are not reconstructible from
   * ids once the request has moved on, and a lead reading last week's bell
   * should see what it said at the time. */
  vacation: 'vacation',
  /* Somebody asked for a file on the office server to be deleted, told to
     whoever answers those asks; and the answer, told back to whoever asked.
     
     TWO KINDS, NOT ONE, because they travel in opposite directions and say
     different things — the first is a job arriving, the second is a job
     finished. The same split `assigned` and `submitted` already make.
     
     THE REASON AND THE NOTE ARE CARRIED IN `detail`, like the reminder kinds
     above: they are typed by a person about a specific file, and rebuilding the
     sentence later from ids would lose the words that explain WHY. The path is
     in there too, because a deletion request is about a path and nothing in
     this schema holds one — there is deliberately no table of files. */
  server_delete_request: 'server_delete_request',
  server_delete_resolved: 'server_delete_resolved',
};

const unavailable = (err) => err && (err.code === 'ER_NO_SUCH_TABLE' || /doesn't exist/i.test(err.message || ''));

/* What the person actually reads.
 *
 * Built here rather than stored pre-rendered so a later wording change applies
 * to the whole history, and so the asset's code and name stay accurate if they
 * are edited after the fact — the row keeps ids, the sentence is made from
 * them. */
function describe(row) {
  /* THE STORED SENTENCE, FIRST AND WITHOUT A FALL-THROUGH. These two kinds are
     the only ones whose words were written at the moment they were raised; see
     KINDS above. The fall-back is a true sentence rather than an empty one,
     because a row from a database without the column must still read as
     something. */
  if (row.kind === KINDS.start_reminder) {
    return row.detail || `${row.other_name || 'A lead'} is checking in: you have not started work today.`;
  }
  if (row.kind === KINDS.timesheet_reminder) {
    return row.detail || 'Please fill your timesheet for the day that is missing.';
  }
  if (row.kind === KINDS.day_status) {
    return row.detail || 'Your day was marked as leave or idle.';
  }
  if (row.kind === KINDS.vacation) {
    return row.detail || `${row.other_name || 'Somebody'}’s vacation changed.`;
  }
  if (row.kind === KINDS.server_delete_request) {
    return row.detail || `${row.other_name || 'Somebody'} asked for a file on the office server to be deleted.`;
  }
  if (row.kind === KINDS.server_delete_resolved) {
    return row.detail || 'Your deletion request on the office server was answered.';
  }
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
  if (row.kind === KINDS.email_trouble) {
    return 'The studio\'s email needs attention — sending may be paused. '
      + 'Open Settings → Email to see what is waiting and why.';
  }
  if (row.kind === KINDS.changes_requested) {
    /* Names the project for the same reason `submitted` does: an artist with
       work in three jobs is being told one of them has come back, and "which
       job is this" is the first thing they ask. */
    const where = row.project_name ? ` in ${row.project_name}` : '';
    const who = row.other_name || 'A reviewer';
    return `${who} sent ${code}${name}${where} back with changes. Open it to read the feedback.`;
  }
  if (row.kind === KINDS.work_paused) {
    return `${code}${name} was paused at the end of the working day. `
      + 'Time outside working hours is not recorded — it starts again on its own '
      + 'when the studio next opens.';
  }
  if (row.kind === KINDS.work_resumed) {
    return `${code}${name} started counting again at the start of the working day. `
      + 'Put it on hold if you are not working on it.';
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
         promise long after the module has finished loading. Through
         selectRows() for the same reason the panel is: a database without the
         detail column must still push. */
      const { rows } = await selectRows(db, 'WHERE n.id = $1', [notificationId]);
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

async function raise(db, { recipientId, actorId, kind, assetId, projectId, otherUserId,
  conversationId, detail }) {
  if (!recipientId || recipientId === actorId) return null;
  const id = uuid();
  try {
    await db.query(
      `INSERT INTO notifications (id, recipient_id, actor_id, kind, asset_id, project_id, other_user_id, conversation_id, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, recipientId, actorId || null, kind, assetId || null, projectId || null,
        otherUserId || null, conversationId || null,
        /* THE ONLY KINDS THAT WRITE THIS, and the slice is the column's width.
           A sentence longer than the column would fail the insert and lose the
           notice, which is a worse outcome than a sentence that ends early. */
        detail === undefined || detail === null ? null : String(detail).slice(0, 500)]
    );
    pushFor(db, { notificationId: id, recipientId, actorId, kind, assetId, projectId });
    return id;
  } catch (err) {
    /* A deployment whose migration has not added project_id, conversation_id or
       detail still notifies — without the link back or the stored sentence,
       which is worth more than silence. describe() has a true fall-back
       sentence for the two kinds that would otherwise have no words at all. */
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
async function assignmentChanged(db, { assetId, from, to, actorId, reason }) {
  /* HANDED BACK TO THE SAME PERSON, which is a real move and not a no-op.
   *
   * "Reassign to Same User" on a review stage puts the rework back on the desk
   * it was already on, as a fresh round — the asset leaves the queue and
   * becomes theirs to start again. They should be told; nobody should be told
   * they lost it, because nobody did.
   *
   * So the pair below becomes a single line, rather than one notification
   * contradicting the other in the same bell. Discriminated on the REASON
   * rather than on from === to alone: every other path that arrives here with
   * the same person on both sides is a save that changed nothing, and telling
   * somebody they have been assigned work they were already doing is the noise
   * this guard was written to stop. */
  const HANDED_BACK = ['reassigned_in_review', 'reassigned_rework'];
  if (from === to) {
    if (!from || !HANDED_BACK.includes(reason)) return;
    await raise(db, { recipientId: to, actorId, kind: KINDS.assigned, assetId, otherUserId: actorId });
    try {
      require('./email-notifications').queueAssignment({ recipientId: to, actorId, assetId });
    } catch (err) {
      console.warn(`[email] could not queue the assignment notice for ${assetId}: ${err.message}`);
    }
    return;
  }
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

/* WORK SENT BACK WITH CHANGES, told to the artist it was routed to.
 *
 * ONE PERSON, not a list: unlike a submission — which several people may be
 * waiting on — feedback goes to the one desk the transition routed it to, and
 * that is the argument. The caller passes the id the workflow decided
 * (verdict.routedTo), so the notification cannot reach somebody the asset was
 * not actually given to.
 *
 * EXACTLY ONCE PER TRANSITION, which is raise()'s own doing rather than a count
 * kept here: one call, one row. The guards that make it fewer are also raise()'s
 * — a null recipient and a recipient who is also the actor are both dropped, so
 * a lead sending their own work back is not told about it by themselves.
 *
 * `actorId` is also `otherUserId`, which is what lets describe() name the
 * reviewer off the same join every other kind uses.
 */
async function changesRequested(db, { assetId, actorId, recipientId }) {
  const id = await raise(db, {
    recipientId, actorId, kind: KINDS.changes_requested, assetId, otherUserId: actorId,
  });
  return id ? 1 : 0;
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
       n.detail,
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

/* THE SAME SELECT WITHOUT THE NEW COLUMN, for a database whose migration has
   not reached it. Derived from the one above by removing that one line rather
   than written out again, so the two cannot drift apart. */
const SELECT_NO_DETAIL = SELECT.replace('\n       n.detail,', '');

/* Run one of the two, whichever the database has.
 *
 * The bell is the single most-polled endpoint in this application, so the
 * fall-back is tried once and remembered rather than attempted on every poll. */
let detailColumn = true;
async function selectRows(db, tail, params) {
  if (detailColumn) {
    try {
      return await db.query(`${SELECT} ${tail}`, params);
    } catch (err) {
      if (!err || err.code !== 'ER_BAD_FIELD_ERROR') throw err;
      detailColumn = false;
    }
  }
  return db.query(`${SELECT_NO_DETAIL} ${tail}`, params);
}

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
  const { rows } = await selectRows(db,
    `WHERE n.recipient_id = $1 ORDER BY n.seq DESC LIMIT ${Number(limit) || 30}`,
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
  const { rows } = await selectRows(db,
    `WHERE n.recipient_id = $1 AND n.seq > $2 ORDER BY n.seq ASC LIMIT 20`,
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
  KINDS, describe, raise, assignmentChanged, taskSubmitted, changesRequested, chatMention,
  listFor, unreadCount, since, highWater, markRead, markAllRead,
};
