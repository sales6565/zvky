const { asyncRouter } = require('../async-router');

// See src/async-router.js: keeps a failed query from killing the process.
const router = asyncRouter();
const db = require('../db');
const { authenticate, requirePermission, can } = require('../middleware/auth');
const chat = require('../chat');
const files = require('../chat-files');
const mentions = require('../chat-mentions');
const status = require('../chat-status');
const notifications = require('../notifications');

/* Chat, and the one decision in it that is a policy rather than a design.
 *
 * THIS HEADER USED TO SAY NOBODY COULD EVER READ A CONVERSATION THEY WERE NOT
 * IN, and that no permission to do so existed or would be added. The studio has
 * since asked for an oversight screen and confirmed it deliberately, so that is
 * no longer true and the paragraph saying it has been replaced rather than left
 * standing. What follows is what is true now.
 *
 * NOBODY READS A CONVERSATION THEY ARE NOT IN *THROUGH THIS ROUTER*. Not a
 * Super Admin, not the holder of any permission, not through any endpoint
 * below. Every route here is behind chat.use and every route touching one
 * conversation is behind membership as well, and neither of those gates has
 * been loosened. An attachment id is still not a bearer token: the membership
 * join is inside the download query rather than checked beside it.
 *
 * READING EVERYBODY'S CHAT is a separate router — src/routes/chat-activity.js
 * — behind a separate permission, settings.chat_activity, which starts held by
 * the Super Admin alone. It is separate on purpose:
 *
 *   - Nothing about ordinary chat changes when it is granted. There is no
 *     branch in this file that reads it, so a mistake there cannot widen this.
 *   - Every use of it is recorded in the Activity Log, naming who looked and
 *     what they filtered by. Reading other people's messages leaves a trace;
 *     taking part in your own does not.
 *   - It is a Settings screen, next to the Activity Log, rather than a mode of
 *     the chat panel — so it reads as oversight, which is what it is.
 *
 * THE COST OF THE CHANGE, stated because it is real and did not stop being real
 * when it was authorised: people say different things when they know they are
 * being read, including "I think this brief is wrong" — the sentence a studio
 * most needs somebody to be able to send. That is why the permission carries a
 * `danger` line telling whoever grants it that staff should be told first, and
 * why the oversight screen says on its face that every visit is logged. Neither
 * of those is a substitute for the studio actually telling people.
 *
 * WHAT IS RECORDED HERE. Group administration — created, renamed, members added
 * and removed — goes to the Activity Log, because a group is a studio object
 * with a membership. Message TRAFFIC still does not, and is still excluded by
 * path in src/middleware/activity.js. That exclusion is now about noise rather
 * than secrecy — a line per message would bury the log — but it stays, because
 * the oversight screen reads the messages themselves and does it better.
 */

router.use(authenticate);

/* Every route below is behind chat.use, and the routes that touch a specific
   conversation are behind membership as well. Two gates answering two
   questions: may this person use chat at all, and is this conversation theirs
   to see. */
router.use(requirePermission('chat.use'));

const notMine = { error: 'That conversation is not yours.' };

/* Resolve :id to the caller's membership, or refuse.
 *
 * 404 rather than 403 for a conversation somebody is not in, deliberately: a
 * 403 would confirm that the id names a real conversation, which is a fact
 * about other people's chat and not one to hand out. */
async function mine(req, res) {
  const seat = await chat.membership(db, req.params.id, req.user.id);
  if (!seat) { res.status(404).json(notMine); return null; }
  return seat;
}

// ------------------------------------------------------------------ reading

// GET /api/chat — the conversation list, with unread counts.
router.get('/', async (req, res) => {
  const [conversations, unread, cursor] = await Promise.all([
    chat.listFor(db, req.user.id),
    chat.unreadTotal(db, req.user.id),
    chat.highWater(db, req.user.id),
  ]);
  res.json({
    conversations,
    unread,
    cursor,
    canCreateGroup: can(req, 'chat.group_create'),
    maxGroupMembers: chat.MAX_GROUP_MEMBERS,
    attachments: {
      allowed: files.ADVERTISED,
      maxBytes: files.MAX_BYTES,
      hours: files.HOURS,
    },
  });
});

/* GET /api/chat/people — who there is to message.
 *
 * Chat needs its own directory, and that is not duplication for its own sake:
 * GET /api/users is behind user.view, which a Game Artist does not hold, so an
 * artist reaching for that list gets a 403 and cannot start a conversation with
 * anybody. Being able to find a colleague is part of being able to talk to one.
 *
 * So this returns the least that makes the picker work: name, designation, and
 * whether there is a photo. Deliberately NOT email, reporting line, project
 * membership or anything else on the user record — that is what user.view is
 * for, and this endpoint must not become a way around it.
 */
router.get('/people', async (req, res) => {
  const { rows } = await db.query(
    'SELECT id, `name`, role, avatar_updated_at AS photoUpdatedAt FROM users WHERE id <> $1 ORDER BY `name`',
    [req.user.id]
  );
  /* A shielded designation is left OUT of the picker rather than shown and
     refused. The studio's choice, and the right one: an option that exists to
     say no teaches people the studio is hiding something, where an absence
     simply is not offered. The server still refuses it — see openDirect below —
     because a list is a convenience and never a control. */
  if (can(req, 'chat.message_protected')) return res.json({ people: rows });
  const shielded = await chat.shieldedAmong(db, rows.map((r) => r.id));
  res.json({ people: rows.filter((r) => !shielded.has(String(r.id))) });
});

/* GET /api/chat/poll?since=<seq>
 *
 * The cheap one, called on a timer by every open tab — so it does as little as
 * possible: a count, and the messages raised since the caller last looked.
 * Without `since` it returns the count alone, which is the call a tab makes
 * when the panel is shut.
 *
 * This is the transport. There is no WebSocket, and the reasoning is in the
 * header of src/chat.js: the deciding constraint is not the hosting but the
 * fact that this app runs as more than one worker, where a push raised on one
 * cannot reach a browser held by another. */
router.get('/poll', async (req, res) => {
  const unread = await chat.unreadTotal(db, req.user.id);
  const fresh = req.query.since !== undefined
    ? await chat.since(db, req.user.id, req.query.since)
    : [];
  const cursor = fresh.length
    ? fresh[fresh.length - 1].seq
    : await chat.highWater(db, req.user.id);

  /* DELIVERED, and this is the moment it becomes true.
   *
   * There is no socket here — chat is a poll — so "the message reached their
   * client" is precisely "a request of theirs returned it", and this is that
   * request. Somebody who was offline when a message was sent is marked
   * delivered by their own first poll on coming back, with nothing asked of
   * the sender, which is the second edge case in the brief.
   *
   * Grouped by conversation because the watermark is per conversation, and
   * marked to the HIGHEST seq handed over in each — one statement per
   * conversation rather than one per message.
   *
   * After the response is decided and never in front of it. A status write
   * that failed, or was slow, must not cost anybody their messages. */
  const highest = new Map();
  for (const m of fresh) {
    const at = Number(m.seq) || 0;
    if (at > (highest.get(m.conversationId) || 0)) highest.set(m.conversationId, at);
  }
  res.json({ unread, fresh, cursor });
  for (const [conversationId, throughSeq] of highest) {
    status.markDelivered(db, { conversationId, userId: req.user.id, throughSeq })
      .catch(() => { /* a tick, never a message */ });
  }
});

// GET /api/chat/:id/messages?before=<seq>
router.get('/:id/messages', async (req, res) => {
  const seat = await mine(req, res);
  if (!seat) return;
  const page = await chat.messagesIn(db, req.params.id, {
    before: req.query.before,
    limit: req.query.limit,
  });
  const members = await chat.membersOf(db, req.params.id);

  /* The ticks on my own messages in this page, and delivery for everybody
     else's. Opening a conversation is the other way a message reaches a
     client — somebody who never polled, because they had the tab shut, is
     handed everything here. */
  const mineHere = page.messages.filter((m) => String(m.senderId) === String(req.user.id));
  const marks = await status.forMessages(db, {
    conversationId: req.params.id, messageIds: mineHere.map((m) => m.id),
  });
  for (const m of page.messages) {
    const mark = marks.get(m.id);
    if (mark) m.status = mark;
  }
  const deliveredTo = page.messages.reduce((top, m) => Math.max(top, Number(m.seq) || 0), 0);

  res.json({
    ...page,
    conversation: {
      id: req.params.id,
      kind: seat.kind,
      title: seat.kind === chat.KINDS.direct
        ? ((members.find((m) => String(m.id) !== String(req.user.id)) || {}).name || 'Removed user')
        : seat.title,
      isOwner: seat.isOwner,
      /* EVERY conversation now names its members, where this used to send them
         for a group and an empty list for a one-to-one.
         
         The mention dropdown is the reason: it offers the people in THIS
         conversation and nobody else, so a one-to-one with no member list
         could offer nobody. Nothing is disclosed by it that the reader did not
         already have — the other person's name is the title of the
         conversation they are looking at. */
      members: members.map(({ conversationId, ...m }) => m),
      memberCount: members.length,
      maxMembers: chat.MAX_GROUP_MEMBERS,
    },
  });

  // Same rule as the poll: after the answer, and it cannot fail the read.
  status.markDelivered(db, { conversationId: req.params.id, userId: req.user.id, throughSeq: deliveredTo })
    .catch(() => {});
});

/* GET /api/chat/:id/status?since=<seq> — the ticks, refreshed.
 *
 * WHAT MAKES THEM MOVE WITHOUT A REFRESH. The panel already polls; when a
 * conversation is open it asks this as well, and repaints whatever has changed.
 * Only the caller's OWN messages have a tick, so only those are counted — a
 * reader has no use for the status of somebody else's message, and asking for
 * it would be asking who has read what in a conversation.
 *
 * `since` bounds it to the recent end of the thread. A conversation four
 * thousand messages long is not four thousand ticks to recompute every fifteen
 * seconds; the ones anybody is looking at are the last few. */
router.get('/:id/status', async (req, res) => {
  const seat = await mine(req, res);
  if (!seat) return;
  const since = Number(req.query.since);
  const { rows } = await db.query(
    `SELECT id FROM chat_messages
      WHERE conversation_id = $1 AND sender_id = $2 AND kind = 'text'
        ${Number.isFinite(since) ? 'AND seq > $3' : ''}
      ORDER BY seq DESC LIMIT 60`,
    Number.isFinite(since) ? [req.params.id, req.user.id, since] : [req.params.id, req.user.id]
  );
  const marks = await status.forMessages(db, {
    conversationId: req.params.id, messageIds: rows.map((r) => r.id),
  });
  req.activitySkip();
  res.json({ statuses: Object.fromEntries(marks) });
});

/* GET /api/chat/:id/messages/:messageId/info — who has had it, and when.
 *
 * FOR THE SENDER ONLY. "Who has read this" is a question about other people,
 * and the one person entitled to ask it is the one waiting on the answer. A
 * member reading somebody else's message has no business knowing which of
 * their colleagues has opened the thread. */
router.get('/:id/messages/:messageId/info', async (req, res) => {
  const seat = await mine(req, res);
  if (!seat) return;
  const { rows } = await db.query(
    'SELECT id, sender_id AS senderId, created_at AS createdAt FROM chat_messages WHERE id = $1 AND conversation_id = $2',
    [req.params.messageId, req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'No such message.' });
  if (String(rows[0].senderId) !== String(req.user.id)) {
    return res.status(403).json({ error: 'Only the person who sent a message can see who has read it.' });
  }
  const people = await status.detailFor(db, {
    conversationId: req.params.id, messageId: req.params.messageId, senderId: req.user.id,
  });
  const marks = await status.forMessages(db, {
    conversationId: req.params.id, messageIds: [req.params.messageId],
  });
  req.activitySkip();
  res.json({
    messageId: req.params.messageId,
    sentAt: rows[0].createdAt,
    status: marks.get(req.params.messageId) || { status: 'sent', delivered: 0, read: 0, audience: 0 },
    people,
  });
});

// ------------------------------------------------------------------ opening

// POST /api/chat/direct { userId } — open (or find) the 1:1 with somebody.
router.post('/direct', async (req, res) => {
  const wanted = String((req.body || {}).userId || '');
  /* The shield, enforced here as well as by leaving them out of the picker.
     The picker is a convenience; this is the control, and it is what answers a
     request made straight to the API. */
  if (wanted && !can(req, 'chat.message_protected')) {
    const shielded = await chat.shieldedAmong(db, [wanted]);
    if (shielded.has(wanted)) {
      return res.status(403).json({ error: 'This person is not available for direct messages.' });
    }
  }
  const result = await chat.openDirect(db, req.user.id, (req.body || {}).userId);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  /* Opening a conversation is not an action worth a line in the studio's
     record — and the line would name who wants to talk to whom, which is the
     metadata this feature deliberately does not keep. */
  req.activitySkip();
  res.json({ conversationId: result.conversationId, created: result.created });
});

// POST /api/chat/groups { title, memberIds[] }
router.post('/groups', requirePermission('chat.group_create'), async (req, res) => {
  const { title, memberIds } = req.body || {};
  /* Shielded people cannot be put in a group by somebody who could not message
     them directly — otherwise the shield is bypassed by making a room and
     talking at them in it.
     
     The creator is exempt from their own check: a shielded person making a
     group is putting THEMSELVES in it, which is not somebody reaching them. */
  const wanted = (Array.isArray(memberIds) ? memberIds : []).map(String)
    .filter((id) => id && id !== String(req.user.id));
  if (wanted.length && !can(req, 'chat.message_protected')) {
    const shielded = await chat.shieldedAmong(db, wanted);
    if (shielded.size) {
      return res.status(403).json({
        error: 'Somebody you picked is not available for messages, so they cannot be added to a group.',
        field: 'memberIds',
      });
    }
  }
  const result = await chat.createGroup(db, {
    title,
    ownerId: req.user.id,
    ownerName: req.user.name,
    memberIds: Array.isArray(memberIds) ? memberIds : [],
  });
  if (!result.ok) return res.status(result.status).json({ error: result.error, field: result.field });
  req.activity({
    module: 'chat',
    action: 'chat.group_created',
    entityType: 'chat_group',
    entityId: result.conversationId,
    entityLabel: String(title).trim(),
    summary: `${req.user.name} created the chat group "${String(title).trim()}" with ${result.members} member(s).`,
  });
  res.status(201).json({ conversationId: result.conversationId, members: result.members });
});

// ------------------------------------------------------------------ sending

/* POST /api/chat/:id/messages — text, files, or both.
 *
 * multipart, because an attachment can come with it. A message with neither
 * words nor a file is refused: it would render as an empty bubble that nobody
 * can tell from a bug. */
router.post('/:id/messages', files.upload.array('files', 5), async (req, res) => {
  const seat = await mine(req, res);
  if (!seat) return;

  const body = String((req.body || {}).body || '').trim();
  const uploaded = Array.isArray(req.files) ? req.files : [];
  if (!body && !uploaded.length) {
    return res.status(400).json({ error: 'Type something, or attach a file.', field: 'body' });
  }

  /* And the shield again, because being IN a conversation is not the same as
     being allowed to write into it — a group made before somebody was shielded,
     or a direct thread somebody opened before the switch was thrown, both leave
     a member who may read and may not send. mayWriteTo lets it through once the
     shielded person has spoken, so their own messages stay answerable. */
  const allowed = await chat.mayWriteTo(db, {
    conversationId: req.params.id,
    senderId: req.user.id,
    senderMay: can(req, 'chat.message_protected'),
  });
  if (!allowed.ok) return res.status(allowed.status).json({ error: allowed.error });

  const messageId = await chat.send(db, {
    conversationId: req.params.id,
    senderId: req.user.id,
    body,
  });
  for (const file of uploaded) {
    await files.record(db, { messageId, file });
  }
  /* Read back rather than assembled from what was just written, so the client
     is given the same shape the poll gives it — one renderer, one set of
     fields, and no second place for an attachment's expiry to be computed. */
  const message = await chat.messageById(db, messageId);
  await chat.markRead(db, req.params.id, req.user.id, message.seq);

  /* PUSHED TO PHONES, and only to phones.
   *
   * Chat deliberately raises no bell notification — the panel's own poll is
   * the in-app signal, and a chat message is not a task waiting on anybody. A
   * push is the same signal for somebody whose phone is in their pocket, so it
   * is sent here rather than by pretending a chat message is a notification
   * row.
   *
   * Fire and forget, for the same reason the assignment push is: a message is
   * already stored and the sender is owed their 201 whatever a phone company
   * is doing. */
  pushChat(req.params.id, req.user, message).catch(() => { /* never fails a send */ });

  /* AND THE PEOPLE NAMED IN IT, on a different channel from the one above.
   *
   * An ordinary message reaches you through chat's own poll and chat's own
   * push. Being TAGGED raises a notification row as well — the bell, the
   * desktop pop-up and the phone, through the same path an assignment takes.
   * That is what makes a mention louder than a message rather than the same
   * thing said twice, and it is deliberately not hung off pushChat(): the
   * studio asked that a mention reach somebody whatever they have done to
   * quieten a conversation, and two separate channels is how that survives a
   * mute being added later. (There is no mute in this application today.)
   *
   * WHO GETS ONE is settled before anything is raised: the ids in the body,
   * intersected with the people actually in this conversation, minus the
   * sender. A token naming somebody who is not a member is dropped in
   * silence — it did not come from the dropdown, which only ever offers
   * members, and telling a stranger they were talked about would be worse
   * than telling nobody.
   *
   * Awaited, unlike the push: it is one local INSERT per person, and awaiting
   * it is what makes the row there when their next poll asks. Wrapped, because
   * the message is already stored and a notification that could not be written
   * must not turn a sent message into an error. */
  try {
    const members = await chat.membersOf(db, req.params.id).catch(() => []);
    const mentioned = mentions.recipients({ body, members, senderId: req.user.id });
    if (mentioned.length) {
      await notifications.chatMention(db, {
        conversationId: req.params.id, actorId: req.user.id, recipientIds: mentioned,
      });
    }
  } catch (err) {
    console.warn(`[chat] could not raise the mentions on ${messageId}: ${err.message}`);
  }

  // Deliberately not logged. See the header of this file.
  req.activitySkip();
  res.status(201).json({ message });
});

/* One push per other member of the conversation.
 *
 * WHAT IT SAYS AND WHAT IT DOES NOT. "Ana sent you a message" and the
 * conversation id — never the message body. A chat body on a lock screen is the
 * one place this application could leak a private conversation to whoever is
 * standing nearby, and the app is two taps away for anybody who wants to read
 * it. */
async function pushChat(conversationId, sender, message) {
  const push = require('../push-notifications');
  if (!push.status().configured) return;
  /* membersOf, not members: the real function takes a LIST of conversation ids
     and returns rows carrying `id` for the person. Guessing at `members()` was
     wrong and would have thrown into the catch above, sending nothing and
     saying nothing. */
  const members = await chat.membersOf(db, [conversationId]).catch(() => []);
  const who = sender.name || sender.email || 'Somebody';
  for (const member of members) {
    const id = member.id;
    if (!id || id === sender.id) continue;
    await push.pushTo(db, id, {
      title: 'Zvky',
      body: `${who} sent you a message.`,
      tag: `chat:${conversationId}`,
      data: { kind: 'chat', conversationId, messageId: message.id || '' },
    }).catch(() => { /* one member's dead phone must not stop the rest */ });
  }
}

// POST /api/chat/:id/read { seq }
router.post('/:id/read', async (req, res) => {
  const seat = await mine(req, res);
  if (!seat) return;
  /* Where they had got to BEFORE this call, read before chat.markRead moves
     it — after that the old value is gone, and the per-message stamps would
     have no gap to fill. */
  const from = Number(seat.lastReadSeq) || 0;
  const marked = await chat.markRead(db, req.params.id, req.user.id, (req.body || {}).seq);
  req.activitySkip();
  res.json({ marked, unread: await chat.unreadTotal(db, req.user.id) });

  /* READ, per message, for the stretch they have just caught up on.
   *
   * The page only calls this from a conversation that is open and visible —
   * see the guard on markChatRead() — which is what makes this mean "they
   * looked at it" rather than "their tab is running somewhere". Read implies
   * delivered, so the same rows get both stamps if the delivery had not
   * already been written. */
  status.markRead(db, {
    conversationId: req.params.id, userId: req.user.id,
    fromSeq: from, throughSeq: (req.body || {}).seq,
  }).catch(() => {});
});

// --------------------------------------------------------------- attachments

/* GET /api/chat/attachments/:attachmentId — the bytes.
 *
 * Authorisation is inside the query (see files.forDownload): there is no way to
 * reach this without being in the conversation the file was sent to.
 *
 * Mounted ABOVE the /:id routes would be wrong and below them is fine —
 * '/attachments/:attachmentId' has two segments and every /:id route above has
 * either one or a fixed second, so nothing shadows it. */
router.get('/attachments/:attachmentId', async (req, res) => {
  const found = await files.forDownload(db, req.params.attachmentId, req.user.id);
  if (!found.ok) return res.status(found.status).json({ error: found.error });

  res.setHeader('Content-Type', found.contentType);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=300');
  if (found.scriptable) {
    /* See the SVG note in src/chat-files.js. Forced download plus a sandbox
       CSP, so an SVG carrying a script never becomes a page on this origin. */
    res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(found.fileName)}"`);
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
  } else {
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(found.fileName)}"`);
  }
  res.sendFile(found.path);
});

// --------------------------------------------------------- group management

/* The owner runs the group: renames it, adds people, removes them. Anybody in
   it may leave. That is the whole model, and it is checked here rather than in
   src/chat.js so the domain functions stay callable from a test without a
   request. */
function ownerOnly(seat, res) {
  if (seat.kind !== chat.KINDS.group) {
    res.status(400).json({ error: 'That is a one-to-one conversation, not a group.' });
    return false;
  }
  if (!seat.isOwner) {
    res.status(403).json({ error: 'Only the person who created this group can change who is in it.' });
    return false;
  }
  return true;
}

// PATCH /api/chat/:id { title }
router.patch('/:id', async (req, res) => {
  const seat = await mine(req, res);
  if (!seat) return;
  if (!ownerOnly(seat, res)) return;
  const result = await chat.rename(db, req.params.id, req.user, (req.body || {}).title);
  if (!result.ok) return res.status(result.status).json({ error: result.error, field: result.field });
  req.activity({
    module: 'chat',
    action: 'chat.group_renamed',
    entityType: 'chat_group',
    entityId: req.params.id,
    entityLabel: result.title,
    summary: `${req.user.name} renamed the chat group "${seat.title}" to "${result.title}".`,
    changes: { title: { from: seat.title, to: result.title } },
  });
  res.json({ title: result.title });
});

// POST /api/chat/:id/members { userIds[] }
router.post('/:id/members', async (req, res) => {
  const seat = await mine(req, res);
  if (!seat) return;
  if (!ownerOnly(seat, res)) return;
  const { userIds } = req.body || {};
  const wanted = (Array.isArray(userIds) ? userIds : []).map(String).filter(Boolean);
  if (wanted.length && !can(req, 'chat.message_protected')) {
    const shielded = await chat.shieldedAmong(db, wanted);
    if (shielded.size) {
      return res.status(403).json({
        error: 'Somebody you picked is not available for messages, so they cannot be added to a group.',
        field: 'userIds',
      });
    }
  }
  const result = await chat.addMembers(db, req.params.id, req.user, wanted);
  if (!result.ok) {
    return res.status(result.status).json({ error: result.error, field: result.field, room: result.room });
  }
  req.activity({
    module: 'chat',
    action: 'chat.group_members_added',
    entityType: 'chat_group',
    entityId: req.params.id,
    entityLabel: seat.title,
    summary: `${req.user.name} added ${result.added.length} person(s) to the chat group "${seat.title}".`,
  });
  res.json({ added: result.added, alreadyIn: result.alreadyIn });
});

// DELETE /api/chat/:id/members/:userId
router.delete('/:id/members/:userId', async (req, res) => {
  const seat = await mine(req, res);
  if (!seat) return;
  if (!ownerOnly(seat, res)) return;
  const result = await chat.removeMember(db, req.params.id, req.user, req.params.userId);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  req.activity({
    module: 'chat',
    action: 'chat.group_member_removed',
    entityType: 'chat_group',
    entityId: req.params.id,
    entityLabel: seat.title,
    summary: `${req.user.name} removed somebody from the chat group "${seat.title}".`,
  });
  res.json({ removed: result.removed });
});

/* POST /api/chat/:id/leave — anybody in a group, including its owner.
 *
 * Not logged. Leaving is the one group action that is about the person rather
 * than about the group: it is somebody choosing to stop reading a conversation,
 * which is the same kind of fact as the conversation itself. */
router.post('/:id/leave', async (req, res) => {
  const seat = await mine(req, res);
  if (!seat) return;
  if (seat.kind !== chat.KINDS.group) {
    return res.status(400).json({ error: 'You cannot leave a one-to-one conversation.' });
  }
  const result = await chat.leave(db, req.params.id, req.user);
  if (!result.ok) return res.status(result.status).json({ error: result.error });
  req.activitySkip();
  res.json({ closed: result.closed, ownerHandedTo: result.ownerHandedTo || null });
});

module.exports = router;
