// Talking to each other.
//
// Two shapes of conversation and one table for both. A DIRECT conversation is
// between exactly two people and is found rather than created — see pairKey()
// below. A GROUP has a name, an owner and up to thirty people in it.
//
// WHAT IS NOT HERE, deliberately: any function that reads a conversation the
// caller is not in. Every read below takes a userId and joins chat_members on
// it, so "am I allowed to see this" is not a check a route can forget to make —
// there is no query here that can answer with somebody else's messages. The
// route layer explains why that is a product decision rather than an oversight.
//
// TRANSPORT. Messages are polled for, not pushed. The reasoning is recorded in
// src/routes/notifications.js and applies here with more force: this app runs
// behind hosting that may or may not carry a WebSocket, and more importantly it
// runs as more than one Node worker in production (see src/reference-data.js),
// where an event pushed from the worker holding one browser cannot reach a
// browser held by another without a shared bus this deployment does not have.
// Polling is correct under any number of workers. `seq` below is what makes it
// cheap and what makes it correct.

const { v4: uuid } = require('uuid');
const files = require('./chat-files');

/* Thirty people in a group, the owner included.
 *
 * Including the owner rather than beside them: "a group of thirty" is thirty
 * people who can read it, and a cap that let the creator sit outside it would
 * make the real limit thirty-one for no reason anybody could explain. */
const MAX_GROUP_MEMBERS = 30;
const MAX_BODY = 4000;
const MAX_TITLE = 120;

const KINDS = { direct: 'direct', group: 'group' };

const unavailable = (err) => err && (err.code === 'ER_NO_SUCH_TABLE' || /doesn't exist/i.test(err.message || ''));

/* The identity of a one-to-one conversation.
 *
 * Sorted, so the pair has one key whichever end asks, and UNIQUE in the schema
 * so two people opening each other at the same moment cannot end up in two
 * different rooms talking past each other. That race is not exotic — it is what
 * happens when two people react to the same thing at once — and it fails
 * silently, which is why it is prevented in the database rather than checked
 * for here. */
function pairKey(a, b) {
  return [String(a), String(b)].sort().join('|');
}

const trimmed = (v, max) => String(v == null ? '' : v).trim().slice(0, max);

// ---------------------------------------------------------------- membership

/* Is this person in this conversation? The one authorisation question chat
   has, asked in one place so every route asks it the same way. */
async function membership(db, conversationId, userId) {
  const { rows } = await db.query(
    `SELECT m.conversation_id AS conversationId, m.user_id AS userId, m.is_owner AS isOwner,
            m.last_read_seq AS lastReadSeq, c.kind, c.title, c.created_by AS createdBy
       FROM chat_members m
       JOIN chat_conversations c ON c.id = m.conversation_id
      WHERE m.conversation_id = $1 AND m.user_id = $2`,
    [conversationId, userId]
  );
  if (!rows.length) return null;
  const r = rows[0];
  return { ...r, isOwner: Boolean(Number(r.isOwner)), lastReadSeq: Number(r.lastReadSeq) || 0 };
}

async function memberCount(db, conversationId) {
  const { rows } = await db.query(
    'SELECT COUNT(*) AS n FROM chat_members WHERE conversation_id = $1',
    [conversationId]
  );
  return Number(rows[0].n) || 0;
}

async function membersOf(db, conversationIds) {
  const list = (Array.isArray(conversationIds) ? conversationIds : [conversationIds]).filter(Boolean);
  if (!list.length) return [];
  const { rows } = await db.query(
    `SELECT m.conversation_id AS conversationId, m.user_id AS userId, m.is_owner AS isOwner,
            u.\`name\`, u.email, u.role, u.avatar_updated_at AS photoUpdatedAt
       FROM chat_members m
       JOIN users u ON u.id = m.user_id
      WHERE m.conversation_id IN ($1)
      ORDER BY m.is_owner DESC, m.seq ASC`,
    [list]
  );
  return rows.map((r) => ({
    conversationId: r.conversationId,
    id: r.userId,
    name: r.name,
    email: r.email,
    role: r.role,
    photoUpdatedAt: r.photoUpdatedAt || null,
    isOwner: Boolean(Number(r.isOwner)),
  }));
}

// ------------------------------------------------------------ system entries

/* A line in the transcript that nobody typed: who was added, who left, what the
 * group was renamed to.
 *
 * The sentence is stored as written rather than rebuilt on read, which is the
 * opposite of what src/notifications.js does and is deliberate. A notification
 * is a statement about the world as it is now, so it should track a rename. A
 * transcript is a record of what was true at the time — "Ava added Ben" stays
 * that sentence even if Ben's account is renamed afterwards, the same way
 * anything else said in the conversation does. */
async function systemLine(conn, conversationId, text) {
  const id = uuid();
  await conn.query(
    'INSERT INTO chat_messages (id, conversation_id, sender_id, kind, body) VALUES ($1,$2,NULL,$3,$4)',
    [id, conversationId, 'system', trimmed(text, MAX_BODY)]
  );
  return id;
}

// ------------------------------------------------------------------- opening

/* The one-to-one conversation between two people, made if it is not there yet.
 *
 * Returns the existing one whenever there is one, so "message Ben" always lands
 * in the same thread and history is never split. The ER_DUP_ENTRY branch is the
 * race described at pairKey(): somebody else won, so read what they made. */
async function openDirect(db, meId, otherId) {
  if (!otherId) return { ok: false, status: 400, error: 'Choose somebody to message.' };
  if (String(meId) === String(otherId)) {
    return { ok: false, status: 400, error: 'You cannot open a conversation with yourself.' };
  }
  const { rows: who } = await db.query('SELECT id FROM users WHERE id = $1', [otherId]);
  if (!who.length) return { ok: false, status: 404, error: 'That person is no longer in the studio.' };

  const key = pairKey(meId, otherId);
  const found = await db.query('SELECT id FROM chat_conversations WHERE pair_key = $1', [key]);
  if (found.rows.length) return { ok: true, conversationId: found.rows[0].id, created: false };

  const conn = await db.connect();
  try {
    await conn.query('BEGIN');
    const id = uuid();
    await conn.query(
      'INSERT INTO chat_conversations (id, kind, pair_key, created_by) VALUES ($1,$2,$3,$4)',
      [id, KINDS.direct, key, meId]
    );
    await conn.query(
      'INSERT INTO chat_members (conversation_id, user_id, is_owner) VALUES ($1,$2,0), ($1,$3,0)',
      [id, meId, otherId]
    );
    await conn.query('COMMIT');
    return { ok: true, conversationId: id, created: true };
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    if (err.code === 'ER_DUP_ENTRY') {
      const again = await db.query('SELECT id FROM chat_conversations WHERE pair_key = $1', [key]);
      if (again.rows.length) return { ok: true, conversationId: again.rows[0].id, created: false };
    }
    throw err;
  } finally {
    conn.release();
  }
}

/* A group. The creator is its owner and its first member.
 *
 * Every id is checked against `users` before anything is written, because a
 * group half-created with two of its five people in it is worse than a refused
 * one — and the caller has no way to tell the difference afterwards. */
async function createGroup(db, { title, ownerId, memberIds = [], ownerName = '' }) {
  const name = trimmed(title, MAX_TITLE);
  if (!name) return { ok: false, status: 400, error: 'Give the group a name.', field: 'title' };

  // The owner is always in it, and a list that names them twice is a typo
  // rather than an error worth refusing.
  const wanted = [...new Set([String(ownerId), ...memberIds.map(String).filter(Boolean)])];
  if (wanted.length > MAX_GROUP_MEMBERS) {
    return {
      ok: false,
      status: 400,
      error: `A group holds at most ${MAX_GROUP_MEMBERS} people, counting you. That is ${wanted.length}.`,
      field: 'memberIds',
    };
  }
  const { rows: real } = await db.query('SELECT id FROM users WHERE id IN ($1)', [wanted]);
  if (real.length !== wanted.length) {
    return { ok: false, status: 400, error: 'Some of those people are no longer in the studio.', field: 'memberIds' };
  }

  const conn = await db.connect();
  try {
    await conn.query('BEGIN');
    const id = uuid();
    await conn.query(
      'INSERT INTO chat_conversations (id, kind, title, created_by) VALUES ($1,$2,$3,$4)',
      [id, KINDS.group, name, ownerId]
    );
    for (const userId of wanted) {
      await conn.query(
        'INSERT INTO chat_members (conversation_id, user_id, is_owner) VALUES ($1,$2,$3)',
        [id, userId, String(userId) === String(ownerId) ? 1 : 0]
      );
    }
    await systemLine(conn, id, `${ownerName || 'Someone'} created “${name}”.`);
    await conn.query('COMMIT');
    return { ok: true, conversationId: id, members: wanted.length };
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

// ---------------------------------------------------------- group management

async function rename(db, conversationId, actor, title) {
  const name = trimmed(title, MAX_TITLE);
  if (!name) return { ok: false, status: 400, error: 'Give the group a name.', field: 'title' };
  const conn = await db.connect();
  try {
    await conn.query('BEGIN');
    await conn.query('UPDATE chat_conversations SET title = $1 WHERE id = $2', [name, conversationId]);
    await systemLine(conn, conversationId, `${actor.name} renamed the group to “${name}”.`);
    await conn.query('COMMIT');
    return { ok: true, title: name };
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/* Adding people, with the cap applied to the RESULT rather than to the request.
 *
 * Counted as "who would be in it afterwards", so adding five to a group of
 * twenty-eight is refused as a whole instead of adding two and dropping three
 * silently. Anybody already in the group is dropped from the request first, so
 * re-adding somebody is a no-op rather than a way to trip the cap. */
async function addMembers(db, conversationId, actor, userIds = []) {
  const wanted = [...new Set(userIds.map(String).filter(Boolean))];
  if (!wanted.length) return { ok: false, status: 400, error: 'Choose somebody to add.', field: 'userIds' };

  const { rows: already } = await db.query(
    'SELECT user_id AS id FROM chat_members WHERE conversation_id = $1',
    [conversationId]
  );
  const inIt = new Set(already.map((r) => String(r.id)));
  const fresh = wanted.filter((id) => !inIt.has(id));
  if (!fresh.length) return { ok: true, added: [], alreadyIn: wanted.length };

  if (inIt.size + fresh.length > MAX_GROUP_MEMBERS) {
    return {
      ok: false,
      status: 400,
      error: `A group holds at most ${MAX_GROUP_MEMBERS} people. This one has ${inIt.size}, `
        + `so there is room for ${Math.max(0, MAX_GROUP_MEMBERS - inIt.size)} more, not ${fresh.length}.`,
      field: 'userIds',
      room: Math.max(0, MAX_GROUP_MEMBERS - inIt.size),
    };
  }

  const { rows: real } = await db.query('SELECT id, `name` FROM users WHERE id IN ($1)', [fresh]);
  if (real.length !== fresh.length) {
    return { ok: false, status: 400, error: 'Some of those people are no longer in the studio.', field: 'userIds' };
  }

  const conn = await db.connect();
  try {
    await conn.query('BEGIN');
    for (const row of real) {
      await conn.query(
        'INSERT INTO chat_members (conversation_id, user_id, is_owner) VALUES ($1,$2,0)',
        [conversationId, row.id]
      );
    }
    await systemLine(conn, conversationId,
      `${actor.name} added ${real.map((r) => r.name).join(', ')}.`);
    await conn.query('COMMIT');
    return { ok: true, added: real.map((r) => r.id), alreadyIn: wanted.length - fresh.length };
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

async function removeMember(db, conversationId, actor, userId) {
  if (String(userId) === String(actor.id)) {
    return { ok: false, status: 400, error: 'Use Leave group to take yourself out.' };
  }
  const { rows } = await db.query(
    'SELECT m.is_owner AS isOwner, u.`name` FROM chat_members m JOIN users u ON u.id = m.user_id '
    + 'WHERE m.conversation_id = $1 AND m.user_id = $2',
    [conversationId, userId]
  );
  if (!rows.length) return { ok: false, status: 404, error: 'They are not in this group.' };
  if (Number(rows[0].isOwner)) return { ok: false, status: 400, error: 'The owner cannot be removed.' };

  const conn = await db.connect();
  try {
    await conn.query('BEGIN');
    await conn.query('DELETE FROM chat_members WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, userId]);
    await systemLine(conn, conversationId, `${actor.name} removed ${rows[0].name}.`);
    await conn.query('COMMIT');
    return { ok: true, removed: userId };
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

/* Leaving, including the case nobody thinks about until it happens.
 *
 * If the OWNER leaves, the group does not become unmanageable: ownership moves
 * to whoever has been in it longest. And if the last person leaves, the
 * conversation is deleted outright — a group with no members is not a thing
 * anybody can reach again, so keeping it would only be keeping rows nobody can
 * ever read. Messages and attachment rows go with it through ON DELETE CASCADE;
 * the files themselves are cleaned by the sweep in src/chat-files.js, which
 * looks at the disk rather than at this table. */
async function leave(db, conversationId, actor) {
  const conn = await db.connect();
  try {
    await conn.query('BEGIN');
    const { rows: mine } = await conn.query(
      'SELECT is_owner AS isOwner FROM chat_members WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, actor.id]
    );
    if (!mine.length) { await conn.query('ROLLBACK'); return { ok: false, status: 404, error: 'You are not in this group.' }; }

    await conn.query('DELETE FROM chat_members WHERE conversation_id = $1 AND user_id = $2',
      [conversationId, actor.id]);

    /* By seq, not joined_at: everybody added when the group was created shares
       one second, and DATETIME cannot order within one. See the schema note. */
    const { rows: left } = await conn.query(
      'SELECT user_id AS id FROM chat_members WHERE conversation_id = $1 ORDER BY seq ASC',
      [conversationId]
    );
    if (!left.length) {
      await conn.query('DELETE FROM chat_conversations WHERE id = $1', [conversationId]);
      await conn.query('COMMIT');
      return { ok: true, closed: true };
    }

    let handedTo = null;
    if (Number(mine[0].isOwner)) {
      handedTo = left[0].id;
      await conn.query('UPDATE chat_members SET is_owner = 1 WHERE conversation_id = $1 AND user_id = $2',
        [conversationId, handedTo]);
    }
    await systemLine(conn, conversationId, `${actor.name} left the group.`);
    await conn.query('COMMIT');
    return { ok: true, closed: false, ownerHandedTo: handedTo };
  } catch (err) {
    await conn.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    conn.release();
  }
}

// -------------------------------------------------------------------- lists

/* Everything this person is in, with what they have not read.
 *
 * Unread excludes the caller's own messages: a thread does not become unread
 * because you posted in it, and counting your own would leave every
 * conversation permanently bold on whichever tab did not send it. */
async function listFor(db, userId) {
  const { rows } = await db.query(
    `SELECT c.id, c.kind, c.title, c.created_by AS createdBy, m.is_owner AS isOwner,
            m.last_read_seq AS lastReadSeq,
            (SELECT MAX(x.seq) FROM chat_messages x WHERE x.conversation_id = c.id) AS lastSeq,
            (SELECT COUNT(*) FROM chat_messages x
              WHERE x.conversation_id = c.id AND x.seq > m.last_read_seq
                AND (x.sender_id IS NULL OR x.sender_id <> $1)
                AND x.kind = 'text') AS unread
       FROM chat_members m
       JOIN chat_conversations c ON c.id = m.conversation_id
      WHERE m.user_id = $1`,
    [userId]
  ).catch((err) => { if (unavailable(err)) return { rows: [] }; throw err; });
  if (!rows.length) return [];

  const ids = rows.map((r) => r.id);
  const lastSeqs = rows.map((r) => Number(r.lastSeq)).filter((n) => Number.isFinite(n) && n > 0);
  const [members, lastMessages] = await Promise.all([
    membersOf(db, ids),
    lastSeqs.length
      ? db.query(
        `SELECT m.conversation_id AS conversationId, m.seq, m.kind, m.body, m.created_at AS createdAt,
                m.sender_id AS senderId, u.\`name\` AS senderName,
                (SELECT COUNT(*) FROM chat_attachments a WHERE a.message_id = m.id) AS attachmentCount
           FROM chat_messages m LEFT JOIN users u ON u.id = m.sender_id
          WHERE m.seq IN ($1)`, [lastSeqs]
      ).then((r) => r.rows)
      : Promise.resolve([]),
  ]);

  const byConv = new Map();
  for (const m of members) {
    if (!byConv.has(m.conversationId)) byConv.set(m.conversationId, []);
    byConv.get(m.conversationId).push(m);
  }
  const lastBySeq = new Map(lastMessages.map((m) => [Number(m.seq), m]));

  return rows.map((r) => {
    const people = byConv.get(r.id) || [];
    const other = r.kind === KINDS.direct ? people.find((p) => String(p.id) !== String(userId)) || null : null;
    const last = lastBySeq.get(Number(r.lastSeq)) || null;
    return {
      id: r.id,
      kind: r.kind,
      /* A direct conversation is named after the person you are talking to, so
         it reads the same to both ends without storing two titles. */
      title: r.kind === KINDS.direct ? (other ? other.name : 'Removed user') : r.title,
      isOwner: Boolean(Number(r.isOwner)),
      createdBy: r.createdBy || null,
      memberCount: people.length,
      members: r.kind === KINDS.group ? people.map(({ conversationId, ...p }) => p) : [],
      other: other ? { id: other.id, name: other.name, role: other.role, photoUpdatedAt: other.photoUpdatedAt } : null,
      unread: Number(r.unread) || 0,
      lastSeq: Number(r.lastSeq) || 0,
      lastReadSeq: Number(r.lastReadSeq) || 0,
      lastMessage: last
        ? {
          seq: Number(last.seq),
          kind: last.kind,
          senderId: last.senderId || null,
          senderName: last.senderName || null,
          preview: previewOf(last),
          createdAt: last.createdAt,
        }
        : null,
    };
  }).sort((a, b) => (b.lastSeq - a.lastSeq) || String(a.title).localeCompare(String(b.title)));
}

/* One line for the conversation list. An attachment with no words is still
   worth a line, or a photo sent on its own would look like an empty thread. */
function previewOf(row) {
  const body = String(row.body || '').replace(/\s+/g, ' ').trim();
  if (body) return body.slice(0, 140);
  const n = Number(row.attachmentCount) || 0;
  if (n === 1) return 'Sent a file';
  if (n > 1) return `Sent ${n} files`;
  return '';
}

// ----------------------------------------------------------------- messages

const MESSAGE_SELECT = `SELECT m.id, m.seq, m.conversation_id AS conversationId, m.kind, m.body,
       m.created_at AS createdAt, m.sender_id AS senderId,
       u.\`name\` AS senderName, u.avatar_updated_at AS senderPhotoUpdatedAt
  FROM chat_messages m
  LEFT JOIN users u ON u.id = m.sender_id`;

/* Attach the files to their messages, with expiry decided by the CLOCK and not
   by whether the sweep has run yet. See src/chat-files.js — this is the reason
   an attachment row outlives its file. */
async function withAttachments(db, messages) {
  if (!messages.length) return messages;
  const ids = messages.map((m) => m.id);
  const { rows } = await db.query(
    `SELECT id, message_id AS messageId, file_name AS fileName, mime, byte_size AS byteSize,
            stored_name AS storedName, expires_at AS expiresAt, deleted_at AS deletedAt
       FROM chat_attachments WHERE message_id IN ($1)`,
    [ids]
  ).catch((err) => { if (unavailable(err)) return { rows: [] }; throw err; });

  const byMessage = new Map();
  for (const row of rows) {
    if (!byMessage.has(row.messageId)) byMessage.set(row.messageId, []);
    byMessage.get(row.messageId).push(files.shape(row));
  }
  return messages.map((m) => ({ ...m, attachments: byMessage.get(m.id) || [] }));
}

const shapeMessage = (r) => ({
  id: r.id,
  seq: Number(r.seq),
  conversationId: r.conversationId,
  kind: r.kind,
  body: r.body || '',
  senderId: r.senderId || null,
  senderName: r.senderName || (r.kind === 'system' ? null : 'Removed user'),
  senderPhotoUpdatedAt: r.senderPhotoUpdatedAt || null,
  createdAt: r.createdAt,
  attachments: [],
});

/* A page of a conversation, oldest last.
 *
 * Read newest-first with a LIMIT and then reversed, because "the most recent
 * thirty" is the page a chat window wants and ORDER BY seq ASC LIMIT 30 gives
 * the oldest thirty instead. `before` pages backwards through the history. */
async function messagesIn(db, conversationId, { before, limit = 40 } = {}) {
  const n = Math.min(Math.max(Number(limit) || 40, 1), 100);
  const beforeSeq = Number(before);
  const params = [conversationId];
  let where = 'WHERE m.conversation_id = $1';
  if (Number.isFinite(beforeSeq) && beforeSeq > 0) { where += ' AND m.seq < $2'; params.push(beforeSeq); }

  const { rows } = await db.query(
    `${MESSAGE_SELECT} ${where} ORDER BY m.seq DESC LIMIT ${n}`, params
  ).catch((err) => { if (unavailable(err)) return { rows: [] }; throw err; });

  const page = rows.map(shapeMessage).reverse();
  return {
    messages: await withAttachments(db, page),
    /* Whether there is more behind this page. A full page is the only case
       where there might be, so this costs nothing when there is not. */
    hasMore: rows.length === n,
  };
}

async function send(db, { conversationId, senderId, body }) {
  const text = trimmed(body, MAX_BODY);
  const id = uuid();
  await db.query(
    'INSERT INTO chat_messages (id, conversation_id, sender_id, kind, body) VALUES ($1,$2,$3,$4,$5)',
    [id, conversationId, senderId, 'text', text]
  );
  return id;
}

async function messageById(db, id) {
  const { rows } = await db.query(`${MESSAGE_SELECT} WHERE m.id = $1`, [id]);
  if (!rows.length) return null;
  const [one] = await withAttachments(db, [shapeMessage(rows[0])]);
  return one;
}

/* Everything raised in the caller's conversations since they last looked.
 *
 * The cursor is a sequence number, never a timestamp — see the schema note on
 * chat_messages.seq. The caller's own messages are included: a person with the
 * app open in two tabs should see what they sent from the other one.
 *
 * Bounded at 50. A client that has been away long enough to be further behind
 * than that re-reads the conversation instead, which is cheaper for both ends
 * than a poll that returns a thousand rows. */
async function since(db, userId, cursor, { limit = 50 } = {}) {
  const from = Number(cursor);
  if (!Number.isFinite(from)) return [];
  const n = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const { rows } = await db.query(
    `${MESSAGE_SELECT}
      JOIN chat_members me ON me.conversation_id = m.conversation_id AND me.user_id = $1
     WHERE m.seq > $2
     ORDER BY m.seq ASC LIMIT ${n}`,
    [userId, from]
  ).catch((err) => { if (unavailable(err)) return { rows: [] }; throw err; });
  return withAttachments(db, rows.map(shapeMessage));
}

// The newest sequence anywhere in this person's conversations, or 0.
async function highWater(db, userId) {
  const { rows } = await db.query(
    `SELECT COALESCE(MAX(m.seq), 0) AS seq
       FROM chat_messages m
       JOIN chat_members me ON me.conversation_id = m.conversation_id AND me.user_id = $1`,
    [userId]
  ).catch((err) => { if (unavailable(err)) return { rows: [{ seq: 0 }] }; throw err; });
  return Number(rows[0].seq) || 0;
}

async function unreadTotal(db, userId) {
  const { rows } = await db.query(
    `SELECT COUNT(*) AS n
       FROM chat_messages m
       JOIN chat_members me ON me.conversation_id = m.conversation_id AND me.user_id = $1
      WHERE m.seq > me.last_read_seq AND m.kind = 'text'
        AND (m.sender_id IS NULL OR m.sender_id <> $1)`,
    [userId]
  ).catch((err) => { if (unavailable(err)) return { rows: [{ n: 0 }] }; throw err; });
  return Number(rows[0].n) || 0;
}

/* Marking read only ever moves forward. Sending a stale sequence — an old tab
   catching up, a request that overtook another — must not make read messages
   unread again. */
async function markRead(db, conversationId, userId, seq) {
  const to = Number(seq);
  if (!Number.isFinite(to)) return 0;
  const out = await db.query(
    'UPDATE chat_members SET last_read_seq = $1 WHERE conversation_id = $2 AND user_id = $3 AND last_read_seq < $1',
    [to, conversationId, userId]
  ).catch((err) => { if (unavailable(err)) return null; throw err; });
  return Number((out && out.result && out.result.affectedRows) || 0);
}

module.exports = {
  MAX_GROUP_MEMBERS, MAX_BODY, MAX_TITLE, KINDS,
  pairKey, membership, memberCount, membersOf,
  openDirect, createGroup, rename, addMembers, removeMember, leave,
  listFor, messagesIn, send, messageById, since, highWater, unreadTotal, markRead,
};
