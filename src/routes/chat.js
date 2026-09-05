const { asyncRouter } = require('../async-router');

// See src/async-router.js: keeps a failed query from killing the process.
const router = asyncRouter();
const db = require('../db');
const { authenticate, requirePermission, can } = require('../middleware/auth');
const chat = require('../chat');
const files = require('../chat-files');

/* Chat, and the one decision in it that is a policy rather than a design.
 *
 * NOBODY CAN READ A CONVERSATION THEY ARE NOT IN. Not a Super Admin, not the
 * holder of any permission, not through any endpoint on this router. There is
 * no "view all chats" screen, no export, and no permission that could be
 * granted to produce one — the catalogue does not contain a key for it, so it
 * is not a switch somebody could find and turn on by accident.
 *
 * That is a deliberate answer to a real question, not an omission. The studio
 * already has an Activity Log, and it records what people DID to the work:
 * assignments, reviews, deliveries, settings. Chat is what people SAID to each
 * other, and the two are different in kind. A record of the second, readable by
 * whoever administers the system, changes what people are willing to say in it
 * — including "I think this brief is wrong", which is the sentence a studio
 * most needs somebody to be able to send.
 *
 * The consequence, stated plainly because it is the cost of the choice: this
 * feature cannot be used for HR investigations or compliance review. If the
 * studio ever needs that, it is not a toggle to add here — it needs a decision
 * about disclosure, a retention policy, and the people using it being told
 * before they type rather than after. Building the capability quietly now and
 * deciding later is the one route that is not available, because the thing that
 * makes it safe is that it does not exist.
 *
 * WHAT IS RECORDED. Group administration — created, renamed, members added and
 * removed — goes to the Activity Log, because a group is a studio object with a
 * membership, and who was put in one is an administrative fact. Message traffic
 * does not, and is excluded by path in src/middleware/activity.js. That
 * exclusion covers metadata as much as content: the middleware never sees a
 * request body, so text was never at risk, but an entry per message would
 * record who talked to whom and how often, which is most of what a message log
 * is for.
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
  res.json({ people: rows });
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
  res.json({ unread, fresh, cursor });
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
  res.json({
    ...page,
    conversation: {
      id: req.params.id,
      kind: seat.kind,
      title: seat.kind === chat.KINDS.direct
        ? ((members.find((m) => String(m.id) !== String(req.user.id)) || {}).name || 'Removed user')
        : seat.title,
      isOwner: seat.isOwner,
      members: seat.kind === chat.KINDS.group ? members.map(({ conversationId, ...m }) => m) : [],
      memberCount: members.length,
      maxMembers: chat.MAX_GROUP_MEMBERS,
    },
  });
});

// ------------------------------------------------------------------ opening

// POST /api/chat/direct { userId } — open (or find) the 1:1 with somebody.
router.post('/direct', async (req, res) => {
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

  // Deliberately not logged. See the header of this file.
  req.activitySkip();
  res.status(201).json({ message });
});

// POST /api/chat/:id/read { seq }
router.post('/:id/read', async (req, res) => {
  const seat = await mine(req, res);
  if (!seat) return;
  const marked = await chat.markRead(db, req.params.id, req.user.id, (req.body || {}).seq);
  req.activitySkip();
  res.json({ marked, unread: await chat.unreadTotal(db, req.user.id) });
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
  const result = await chat.addMembers(db, req.params.id, req.user, Array.isArray(userIds) ? userIds : []);
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
