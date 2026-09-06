/* Reading every conversation in the studio, for the Chat Activity screen.
 *
 * A MODULE OF ITS OWN, and that is the point of it. src/chat.js is the domain
 * everybody's own chat runs through, and every function in it is scoped to a
 * conversation the caller is in. A "read everything" query living there would
 * be one mistaken call away from widening the panel itself. Here it can only be
 * reached by something that imported this file, which is one route.
 *
 * WHAT IT RETURNS: every message, one-to-one and group, with its sender, the
 * conversation it belongs to and who is in that conversation, the time, the
 * text, and the state of any file on it. No exceptions and no redactions — the
 * studio asked for a complete record, including the conversations only a Super
 * Admin may start (see chat.open_inbox), because a log with holes in it is
 * worse than no log for the purpose this one has.
 *
 * WHAT IT DOES NOT DO: it does not extend the life of anything. An attachment
 * is still deleted twelve hours after it was sent, and this screen shows the
 * same placeholder the panel does once that has happened. Oversight reads what
 * is there; it does not preserve what would otherwise have gone. The expiry
 * check is chat-files.js's own, so the two cannot drift apart.
 */
const files = require('./chat-files');

const unavailable = (err) => err
  && (err.code === 'ER_NO_SUCH_TABLE' || /doesn't exist/i.test(err.message || ''));

// A page at a time, and the same ceiling the Activity Log uses.
const PAGE_MAX = 200;
const PAGE_DEFAULT = 50;

/* The filters, built the way src/activity.js builds its own — same shape, same
 * inclusive whole-day dates — so the two screens behave identically for
 * somebody who has learned one of them.
 *
 * `personId` is deliberately not `actorId`: on the Activity Log the person IS
 * the actor, and here they may be the sender OR simply in the room. Somebody
 * looking into one person's chat wants both, and a filter that returned only
 * what they typed would hide the half of the conversation that was about them.
 */
function buildQuery(filter = {}) {
  const where = [];
  const params = [];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace('?', `$${params.length}`));
  };

  if (filter.personId) {
    /* Sent by them, or sent in a conversation they are in. EXISTS rather than a
       join, so a message in a group of thirty is not returned thirty times. */
    params.push(filter.personId, filter.personId);
    where.push(`(m.sender_id = $${params.length - 1} OR EXISTS (
      SELECT 1 FROM chat_members cm
       WHERE cm.conversation_id = m.conversation_id AND cm.user_id = $${params.length}))`);
  }
  if (filter.conversationId) add('m.conversation_id = ?', filter.conversationId);
  if (filter.kind === 'direct' || filter.kind === 'group') add('c.kind = ?', filter.kind);
  // Whole days, inclusive at both ends — "1st to 3rd" has to include the 3rd.
  if (filter.from) add('m.created_at >= ?', `${filter.from} 00:00:00`);
  if (filter.to) add('m.created_at <= ?', `${filter.to} 23:59:59`);
  if (filter.withFiles === true || filter.withFiles === 'true' || filter.withFiles === '1') {
    where.push('EXISTS (SELECT 1 FROM chat_attachments fa WHERE fa.message_id = m.id)');
  }
  if (filter.q) {
    /* The message text, the sender's name, and the group's title. Not the file
       name: a search that matched it would return a message whose visible words
       do not contain the term, which reads as a bug. */
    const like = `%${String(filter.q).slice(0, 100)}%`;
    params.push(like, like, like);
    where.push(`(m.body LIKE $${params.length - 2} OR u.\`name\` LIKE $${params.length - 1}`
      + ` OR c.title LIKE $${params.length})`);
  }
  return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

const FROM = `FROM chat_messages m
  LEFT JOIN chat_conversations c ON c.id = m.conversation_id
  LEFT JOIN users u ON u.id = m.sender_id`;

const SELECT = `SELECT m.id, m.seq, m.kind, m.body, m.created_at AS createdAt,
       m.conversation_id AS conversationId,
       m.sender_id AS senderId, u.\`name\` AS senderName, u.email AS senderEmail,
       u.\`role\` AS senderRole, u.avatar_updated_at AS senderPhotoUpdatedAt,
       c.kind AS conversationKind, c.title AS conversationTitle,
       c.created_at AS conversationStartedAt`;

/* Who is in each conversation on this page.
 *
 * One query for the whole page rather than one per row: a page of fifty
 * messages spread over a dozen conversations is a dozen lookups done as one.
 * Members include people who have since LEFT a group — chat_members loses the
 * row when somebody leaves, so this is the membership as it stands now, not as
 * it was when the message was sent. Said plainly here because it is the kind of
 * thing somebody reading the screen would otherwise assume the other way. */
async function membersOf(db, conversationIds) {
  const out = new Map();
  if (!conversationIds.length) return out;
  const { rows } = await db.query(
    `SELECT cm.conversation_id AS conversationId, cm.user_id AS userId, cm.is_owner AS isOwner,
            u.\`name\` AS \`name\`, u.email, u.\`role\`
       FROM chat_members cm
       LEFT JOIN users u ON u.id = cm.user_id
      WHERE cm.conversation_id IN ($1)
      ORDER BY cm.seq`,
    [conversationIds]
  ).catch((err) => { if (unavailable(err)) return { rows: [] }; throw err; });

  for (const row of rows) {
    if (!out.has(row.conversationId)) out.set(row.conversationId, []);
    out.get(row.conversationId).push({
      id: row.userId,
      name: row.name || 'A removed account',
      email: row.email || '',
      role: row.role || '',
      isOwner: Boolean(row.isOwner),
    });
  }
  return out;
}

async function attachmentsFor(db, messageIds) {
  const out = new Map();
  if (!messageIds.length) return out;
  const { rows } = await db.query(
    `SELECT id, message_id AS messageId, file_name AS fileName, mime, byte_size AS byteSize,
            stored_name AS storedName, expires_at AS expiresAt, deleted_at AS deletedAt
       FROM chat_attachments WHERE message_id IN ($1)`,
    [messageIds]
  ).catch((err) => { if (unavailable(err)) return { rows: [] }; throw err; });

  for (const row of rows) {
    if (!out.has(row.messageId)) out.set(row.messageId, []);
    /* files.shape() decides expiry from the clock, exactly as the panel does,
       and returns url: null once a file has gone. The URL is then pointed at
       this screen's own download route rather than the panel's, because the
       panel's checks membership and the reader has none. */
    const shaped = files.shape(row);
    out.get(row.messageId).push({
      ...shaped,
      url: shaped.url ? `/api/chat-activity/attachments/${row.id}` : null,
    });
  }
  return out;
}

/* How a conversation reads on one line.
 *
 * A group has a title. A direct conversation does not, so it is named by the
 * two people in it — and by both, not "the other one", because there is no
 * "other one" from the point of view of somebody reading who is in neither. */
function describeConversation(kind, title, members) {
  if (kind === 'group') return title || 'Untitled group';
  const names = members.map((m) => m.name);
  if (names.length >= 2) return `${names[0]} and ${names[1]}`;
  if (names.length === 1) return `${names[0]} and a removed account`;
  return 'A closed conversation';
}

async function page(db, filter = {}) {
  const limit = Math.min(Math.max(Number(filter.limit) || PAGE_DEFAULT, 1), PAGE_MAX);
  const offset = Math.max(0, Number(filter.offset) || 0);
  const { clause, params } = buildQuery(filter);

  const counted = await db.query(`SELECT COUNT(*) AS n ${FROM} ${clause}`, params)
    .catch((err) => { if (unavailable(err)) return null; throw err; });
  if (!counted) return { messages: [], total: 0, limit, offset, unavailable: true };

  const { rows } = await db.query(
    `${SELECT} ${FROM} ${clause} ORDER BY m.seq DESC LIMIT ${limit} OFFSET ${offset}`,
    params
  );

  const byConversation = await membersOf(db, [...new Set(rows.map((r) => r.conversationId))]);
  const byMessage = await attachmentsFor(db, rows.map((r) => r.id));

  return {
    total: Number(counted.rows[0].n),
    limit,
    offset,
    messages: rows.map((r) => {
      const members = byConversation.get(r.conversationId) || [];
      return {
        id: r.id,
        seq: Number(r.seq),
        at: r.createdAt,
        /* 'text' for anything somebody typed; other kinds exist for the notices
           chat writes itself. Carried through rather than filtered out: a
           complete record includes "X added Y to this group". */
        kind: r.kind,
        body: r.body,
        sender: r.senderId
          ? {
            id: r.senderId,
            name: r.senderName || 'A removed account',
            email: r.senderEmail || '',
            role: r.senderRole || '',
            photoUpdatedAt: r.senderPhotoUpdatedAt || null,
          }
          : null,
        conversation: {
          id: r.conversationId,
          kind: r.conversationKind || 'direct',
          title: r.conversationTitle || null,
          label: describeConversation(r.conversationKind, r.conversationTitle, members),
          members,
          startedAt: r.conversationStartedAt || null,
        },
        attachments: byMessage.get(r.id) || [],
      };
    }),
  };
}

/* Everybody who has ever sent a message, for the person filter — read off the
   messages rather than off the user list, the same way the Activity Log builds
   its actor filter. A filter offering sixty accounts of whom eight have ever
   chatted is a filter that mostly returns nothing. */
async function people(db) {
  const { rows } = await db.query(
    `SELECT u.id, u.\`name\`, u.email, COUNT(*) AS messages
       FROM chat_messages m JOIN users u ON u.id = m.sender_id
      GROUP BY u.id, u.\`name\`, u.email ORDER BY u.\`name\``
  ).catch((err) => { if (unavailable(err)) return { rows: [] }; throw err; });
  return rows.map((r) => ({ id: r.id, name: r.name, email: r.email, messages: Number(r.messages) }));
}

/* The headline figures, so the screen can say what it is showing before
   anybody scrolls: how much there is, and how much of it is still readable. */
async function summary(db) {
  const one = async (sql) => {
    const { rows } = await db.query(sql).catch((err) => {
      if (unavailable(err)) return { rows: [{ n: 0 }] };
      throw err;
    });
    return Number(rows[0].n) || 0;
  };
  return {
    messages: await one('SELECT COUNT(*) AS n FROM chat_messages'),
    conversations: await one('SELECT COUNT(*) AS n FROM chat_conversations'),
    groups: await one("SELECT COUNT(*) AS n FROM chat_conversations WHERE kind = 'group'"),
    filesLive: await one(
      'SELECT COUNT(*) AS n FROM chat_attachments WHERE deleted_at IS NULL AND expires_at > NOW()'),
    filesExpired: await one(
      'SELECT COUNT(*) AS n FROM chat_attachments WHERE deleted_at IS NOT NULL OR expires_at <= NOW()'),
    retentionHours: files.HOURS,
  };
}

module.exports = { page, people, summary, buildQuery, describeConversation, PAGE_MAX, PAGE_DEFAULT };
